/**
 * Portal logins: scrypt passwords, authenticator TOTP, signed session cookie, audit log.
 * User file lives under PORTAL_DATA_DIR (default ./data/portal), not in git.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const totp = require('./totp');

const COOKIE = 'df_portal';
const SESSION_MS = 12 * 60 * 60 * 1000;
const SETUP_MS = 10 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_FAILS = 8;

function dataDir() {
    return process.env.PORTAL_DATA_DIR || path.join(__dirname, '..', '..', 'data', 'portal');
}

function usersPath() {
    return path.join(dataDir(), 'users.json');
}

function secretPath() {
    return path.join(dataDir(), 'session.secret');
}

function auditPath() {
    return path.join(dataDir(), 'audit.log');
}

function ensureDir() {
    const dir = dataDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    try { fs.chmodSync(dir, 0o700); } catch (_) { /* windows */ }
    return dir;
}

function sessionSecret() {
    ensureDir();
    if (process.env.PORTAL_SESSION_SECRET && String(process.env.PORTAL_SESSION_SECRET).length >= 16) {
        return String(process.env.PORTAL_SESSION_SECRET);
    }
    const p = secretPath();
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
    const secret = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(p, secret, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(p, 0o600); } catch (_) {}
    return secret;
}

function loadUsers() {
    ensureDir();
    const p = usersPath();
    if (!fs.existsSync(p)) return [];
    try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        return Array.isArray(data) ? data : [];
    } catch (e) {
        console.error('[Portal] Could not read users.json:', e.message);
        return [];
    }
}

function saveUsers(users) {
    ensureDir();
    const p = usersPath();
    fs.writeFileSync(p, JSON.stringify(users, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(p, 0o600); } catch (_) {}
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(password), salt, 32);
    return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function verifyPassword(password, stored) {
    if (!stored || typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[1], 'base64url');
    const expected = Buffer.from(parts[2], 'base64url');
    const actual = crypto.scryptSync(String(password), salt, expected.length);
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
}

function publicUser(u) {
    if (!u) return null;
    return {
        id: u.id,
        email: u.email,
        name: u.name || '',
        role: u.role || 'operator',
        totpEnabled: !!u.totpEnabled,
        disabled: !!u.disabled,
        createdAt: u.createdAt || null,
    };
}

function findByEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    return loadUsers().find((u) => u.email === e) || null;
}

function findById(id) {
    return loadUsers().find((u) => u.id === id) || null;
}

function signPayload(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', sessionSecret()).update(body).digest('base64url');
    return `${body}.${sig}`;
}

function readPayload(token) {
    if (!token || !token.includes('.')) return null;
    const [body, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', sessionSecret()).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (!payload || !payload.exp || payload.exp < Date.now()) return null;
        return payload;
    } catch (_) {
        return null;
    }
}

function parseCookies(req) {
    const header = req.headers.cookie || '';
    const out = {};
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        try { out[k] = decodeURIComponent(v); } catch (_) { out[k] = v; }
    }
    return out;
}

function cookieHeader(token, maxAgeSec) {
    const secure = process.env.PORTAL_COOKIE_SECURE === '0' ? '' : '; Secure';
    return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure}`;
}

function clearCookieHeader() {
    const secure = process.env.PORTAL_COOKIE_SECURE === '0' ? '' : '; Secure';
    return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

function userFromRequest(req) {
    const token = parseCookies(req)[COOKIE];
    const payload = readPayload(token);
    if (!payload || payload.purpose !== 'session' || !payload.uid) return null;
    const user = findById(payload.uid);
    if (!user || user.disabled) return null;
    if ((user.sessionVersion || 0) !== (payload.sv || 0)) return null;
    return user;
}

function setSessionCookie(res, user) {
    const token = signPayload({
        purpose: 'session',
        uid: user.id,
        sv: user.sessionVersion || 0,
        exp: Date.now() + SESSION_MS,
    });
    res.setHeader('Set-Cookie', cookieHeader(token, Math.floor(SESSION_MS / 1000)));
}

function setupToken(user) {
    return signPayload({
        purpose: 'totp-setup',
        uid: user.id,
        sv: user.sessionVersion || 0,
        exp: Date.now() + SETUP_MS,
    });
}

function userFromSetupToken(token) {
    const payload = readPayload(token);
    if (!payload || payload.purpose !== 'totp-setup' || !payload.uid) return null;
    const user = findById(payload.uid);
    if (!user || user.disabled) return null;
    if ((user.sessionVersion || 0) !== (payload.sv || 0)) return null;
    return user;
}

const failures = new Map();

function rateKey(req, email) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    return `${ip}|${String(email || '').toLowerCase()}`;
}

function assertNotLocked(req, email) {
    const row = failures.get(rateKey(req, email));
    if (row && row.lockedUntil && row.lockedUntil > Date.now()) {
        const mins = Math.ceil((row.lockedUntil - Date.now()) / 60000);
        const err = new Error(`Too many attempts. Try again in ${mins} minute(s).`);
        err.status = 429;
        throw err;
    }
}

function recordFailure(req, email) {
    const key = rateKey(req, email);
    const row = failures.get(key) || { count: 0, lockedUntil: 0 };
    if (row.lockedUntil && row.lockedUntil < Date.now()) {
        row.count = 0;
        row.lockedUntil = 0;
    }
    row.count += 1;
    if (row.count >= MAX_FAILS) {
        row.lockedUntil = Date.now() + LOCK_MS;
        row.count = 0;
    }
    failures.set(key, row);
}

function clearFailures(req, email) {
    failures.delete(rateKey(req, email));
}

function audit(user, action, detail) {
    try {
        ensureDir();
        const line = JSON.stringify({
            t: new Date().toISOString(),
            user: user && user.email ? user.email : null,
            action,
            detail: detail || null,
        }) + '\n';
        fs.appendFileSync(auditPath(), line);
    } catch (e) {
        console.warn('[Portal] Audit write failed:', e.message);
    }
}

function ensureAdmin() {
    const users = loadUsers();
    if (users.length > 0) return;
    const email = String(process.env.PORTAL_ADMIN_EMAIL || 'admin@localhost').trim().toLowerCase();
    let password = process.env.PORTAL_ADMIN_PASSWORD;
    let generated = false;
    if (!password) {
        password = crypto.randomBytes(9).toString('base64url');
        generated = true;
    }
    const admin = {
        id: crypto.randomBytes(8).toString('hex'),
        email,
        name: 'Admin',
        role: 'admin',
        passwordHash: hashPassword(password),
        totpSecret: null,
        totpEnabled: false,
        sessionVersion: 0,
        disabled: false,
        createdAt: new Date().toISOString(),
    };
    saveUsers([admin]);
    console.log(`[Portal] Created admin login: ${email}`);
    if (generated) {
        console.log(`[Portal] One-time admin password: ${password}`);
        console.log('[Portal] Set PORTAL_ADMIN_PASSWORD before the next empty install, and turn on the authenticator app at first login.');
    } else {
        console.log('[Portal] Admin must turn on the authenticator app at first login.');
    }
}

function updateUser(id, mutator) {
    const users = loadUsers();
    const idx = users.findIndex((u) => u.id === id);
    if (idx < 0) return null;
    mutator(users[idx]);
    saveUsers(users);
    return users[idx];
}

function createUser({ email, name, password, role }) {
    const e = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e !== 'admin@localhost') {
        if (!/^[^\s@]+@[^\s@]+$/.test(e) && !e.includes('@')) {
            const err = new Error('Enter a valid email.');
            err.status = 400;
            throw err;
        }
    }
    if (!e || !e.includes('@')) {
        const err = new Error('Enter a valid email.');
        err.status = 400;
        throw err;
    }
    if (!password || String(password).length < 10) {
        const err = new Error('Password must be at least 10 characters.');
        err.status = 400;
        throw err;
    }
    if (findByEmail(e)) {
        const err = new Error('That email already has a login.');
        err.status = 409;
        throw err;
    }
    const user = {
        id: crypto.randomBytes(8).toString('hex'),
        email: e,
        name: String(name || '').trim().slice(0, 80),
        role: role === 'admin' ? 'admin' : 'operator',
        passwordHash: hashPassword(password),
        totpSecret: null,
        totpEnabled: false,
        sessionVersion: 0,
        disabled: false,
        createdAt: new Date().toISOString(),
    };
    const users = loadUsers();
    users.push(user);
    saveUsers(users);
    return user;
}

function guard(req, res, next) {
    const p = req.path || '';
    if (p === '/login' || p === '/style.css' || p === '/logo.png' || p === '/favicon.ico') {
        return next();
    }
    if (p === '/api/auth/login' || p === '/api/auth/totp/setup' || p === '/api/auth/totp/confirm') {
        return next();
    }
    const user = userFromRequest(req);
    if (!user) {
        if (p.startsWith('/api/') || p.startsWith('/events') || p.startsWith('/process') || p.startsWith('/fetch') || p.startsWith('/load') || p.startsWith('/clear')) {
            return res.status(401).json({ error: 'Login required' });
        }
        return res.redirect('/login');
    }
    req.portalUser = user;
    next();
}

function requireAdmin(req, res, next) {
    if (!req.portalUser || req.portalUser.role !== 'admin') {
        return res.status(403).json({ error: 'Admin only' });
    }
    next();
}

module.exports = {
    COOKIE,
    dataDir,
    publicUser,
    loadUsers,
    hashPassword,
    verifyPassword,
    userFromRequest,
    setSessionCookie,
    setupToken,
    userFromSetupToken,
    clearCookieHeader,
    assertNotLocked,
    recordFailure,
    clearFailures,
    audit,
    ensureAdmin,
    updateUser,
    createUser,
    findByEmail,
    findById,
    guard,
    requireAdmin,
    totp,
};
