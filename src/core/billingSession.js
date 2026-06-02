/**
 * Persists billing run progress for crash recovery / resume.
 * File: {appDataDir}/billing_session.json
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function getAppDataDir() {
    const billingPath = process.env.BILLING_REQUESTS_PATH || path.join(__dirname, '..', '..', 'billing_requests.json');
    return path.dirname(billingPath);
}

const SESSION_FILE = () => path.join(getAppDataDir(), 'billing_session.json');

const COMPLETED_STATUSES = new Set(['success', 'warning', 'skipped']);

/** Fields only needed during live billing — never persist (PDF data URLs are ~0.5–2 MB each). */
const EPHEMERAL_REQUEST_FIELDS = ['proofURL', 'checkOnlyInvoiceAmounts', 'fileName'];

function stripEphemeralRequestFields(req) {
    if (!req || typeof req !== 'object') return req;
    const copy = { ...req };
    for (const key of EPHEMERAL_REQUEST_FIELDS) delete copy[key];
    return copy;
}

function clearEphemeralFromRequest(req) {
    if (!req || typeof req !== 'object') return;
    for (const key of EPHEMERAL_REQUEST_FIELDS) delete req[key];
}

function needsProcessing(req) {
    if (!req || req.skip) return false;
    const st = req.status || 'pending';
    if (st === 'processing') return true;
    return st === 'pending' || st === 'failed' || st === 'stopped';
}

function countRemaining(requests) {
    return (Array.isArray(requests) ? requests : []).filter(needsProcessing).length;
}

function serializeRequests(requests) {
    if (!Array.isArray(requests)) return [];
    return requests.map((r) => stripEphemeralRequestFields(r));
}

function loadSession() {
    try {
        const p = SESSION_FILE();
        if (!fs.existsSync(p)) return null;
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!data || !Array.isArray(data.requests) || data.requests.length === 0) return null;
        if (data.completed) return null;
        return data;
    } catch (e) {
        console.warn('[Session] Could not read billing session:', e.message);
        return null;
    }
}

function writeSession(session) {
    const dir = getAppDataDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const body = JSON.stringify({
        ...session,
        requests: serializeRequests(session.requests),
    });
    fs.writeFileSync(SESSION_FILE(), body, 'utf8');
}

function getSessionSummary() {
    const s = loadSession();
    if (!s) return null;
    const requests = s.requests || [];
    const done = requests.filter((r) => COMPLETED_STATUSES.has(r.status)).length;
    const remaining = countRemaining(requests);
    if (remaining === 0) return null;
    return {
        sessionId: s.sessionId,
        source: s.source,
        startedAt: s.startedAt,
        updatedAt: s.updatedAt,
        total: requests.length,
        done,
        remaining,
        interrupted: !!s.interrupted,
    };
}

function startSession(source, requests, extra = {}) {
    const session = {
        sessionId: crypto.randomUUID(),
        source: source || 'queue',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completed: false,
        interrupted: false,
        requests: serializeRequests(requests),
        ...extra,
    };
    writeSession(session);
    return session.sessionId;
}

function updateSession(source, requests, extra = {}) {
    const existing = loadSession();
    const session = {
        sessionId: existing?.sessionId || crypto.randomUUID(),
        source: source || existing?.source || 'queue',
        startedAt: existing?.startedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completed: false,
        interrupted: false,
        runSettings: existing?.runSettings,
        selectedIds: existing?.selectedIds,
        requests: serializeRequests(requests),
        ...extra,
    };
    writeSession(session);
}

function completeSession() {
    try {
        const p = SESSION_FILE();
        if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {
        console.warn('[Session] Could not remove completed session:', e.message);
    }
}

function clearSession() {
    completeSession();
}

function finalizeSession(requests) {
    if (Array.isArray(requests)) {
        for (const r of requests) {
            if (r && r.status === 'processing') {
                r.status = 'failed';
                const prev = r.message && String(r.message).trim();
                r.message = prev && prev !== 'Starting...'
                    ? `${prev} (run interrupted)`
                    : 'Run interrupted before billing completed';
            }
        }
    }
    if (countRemaining(requests) === 0) completeSession();
    else updateSession(null, requests, { interrupted: true, inProgress: false });
}

function prepareRequestsForResume(rawRequests) {
    return (rawRequests || []).map((r) => {
        const copy = stripEphemeralRequestFields(r);
        if (copy.status === 'processing') {
            copy.status = 'failed';
            const prev = copy.message && String(copy.message).trim();
            copy.message = prev && prev !== 'Starting...'
                ? `${prev} (run interrupted)`
                : 'Run interrupted before billing completed';
        }
        return copy;
    });
}

/** Rewrite an oversized legacy session file without embedded PDF data URLs. */
function compactSessionFileIfNeeded() {
    try {
        const p = SESSION_FILE();
        if (!fs.existsSync(p)) return;
        const size = fs.statSync(p).size;
        if (size < 5 * 1024 * 1024) return;
        const data = loadSession();
        if (!data) return;
        console.log(`[Session] Compacting large session file (${Math.round(size / 1024 / 1024)} MB)...`);
        writeSession(data);
        const newSize = fs.statSync(p).size;
        console.log(`[Session] Compacted to ${Math.round(newSize / 1024)} KB`);
    } catch (e) {
        console.warn('[Session] Compaction skipped:', e.message);
    }
}

module.exports = {
    getSessionPath: SESSION_FILE,
    loadSession,
    getSessionSummary,
    startSession,
    updateSession,
    completeSession,
    clearSession,
    finalizeSession,
    compactSessionFileIfNeeded,
    needsProcessing,
    prepareRequestsForResume,
    countRemaining,
    COMPLETED_STATUSES,
    stripEphemeralRequestFields,
    clearEphemeralFromRequest,
};
