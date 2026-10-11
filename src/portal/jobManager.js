/**
 * Tracks workspaces on disk and spawns one Node process per running job.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const auth = require('./auth');

const ID_RE = /^[a-f0-9]{16}$/;

function dataDir() {
    return auth.dataDir();
}

function jobsDir() {
    const dir = path.join(dataDir(), 'jobs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function maxRunningJobs() {
    const n = parseInt(process.env.PORTAL_MAX_JOBS, 10);
    return Number.isFinite(n) && n > 0 ? n : 2;
}

function maxBrowsersPerJob() {
    const n = parseInt(process.env.PORTAL_MAX_BROWSERS, 10);
    return Number.isFinite(n) && n > 0 ? n : 8;
}

function accountKey(account) {
    return String(account || 'main').trim().toLowerCase() === 'brooklyn' ? 'brooklyn' : 'main';
}

/** In-memory handles. Disk is the source of truth for metadata and queue. */
const runtime = new Map();

function jobDir(id) {
    if (!ID_RE.test(String(id || ''))) {
        const err = new Error('Unknown job');
        err.status = 404;
        throw err;
    }
    return path.join(jobsDir(), id);
}

function readJson(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
        return fallback;
    }
}

function writeJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function metaPath(id) {
    return path.join(jobDir(id), 'job.json');
}

function queuePath(id) {
    return path.join(jobDir(id), 'queue.json');
}

function loadMeta(id) {
    const meta = readJson(metaPath(id), null);
    if (!meta || meta.id !== id) {
        const err = new Error('Unknown job');
        err.status = 404;
        throw err;
    }
    return meta;
}

function saveMeta(meta) {
    meta.updatedAt = new Date().toISOString();
    writeJson(metaPath(meta.id), meta);
    return meta;
}

function loadQueue(id) {
    const rt = runtime.get(id);
    if (rt && Array.isArray(rt.queue)) return rt.queue;
    const q = readJson(queuePath(id), []);
    return Array.isArray(q) ? q : [];
}

function saveQueue(id, queue) {
    const list = Array.isArray(queue) ? queue : [];
    const rt = runtime.get(id);
    if (rt) rt.queue = list;
    writeJson(queuePath(id), list);
    return list;
}

function ensureRuntime(id) {
    let rt = runtime.get(id);
    if (!rt) {
        rt = {
            queue: loadQueue(id),
            logs: [],
            child: null,
            subscribers: new Set(),
            liveClients: new Set(),
            queueTimer: null,
            stopRequested: false,
            finished: false,
        };
        runtime.set(id, rt);
    }
    return rt;
}

function counts(queue) {
    const list = Array.isArray(queue) ? queue : [];
    const doneStatuses = new Set(['success', 'warning', 'skipped']);
    const done = list.filter((r) => doneStatuses.has(r && r.status)).length;
    const remaining = list.filter((r) => {
        const st = (r && r.status) || 'pending';
        return st === 'pending' || st === 'failed' || st === 'processing' || st === 'stopped';
    }).length;
    return { total: list.length, done, remaining };
}

function summary(meta, queue) {
    const c = counts(queue != null ? queue : loadQueue(meta.id));
    return {
        id: meta.id,
        name: meta.name,
        status: meta.status,
        createdBy: meta.createdBy || null,
        startedBy: meta.startedBy || null,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        account: meta.account || null,
        runType: meta.runType || null,
        error: meta.error || null,
        ...c,
    };
}

function listJobs() {
    const dir = jobsDir();
    const ids = fs.readdirSync(dir).filter((name) => ID_RE.test(name));
    const out = [];
    for (const id of ids) {
        try {
            const meta = loadMeta(id);
            out.push(summary(meta));
        } catch (_) { /* skip junk */ }
    }
    out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return out;
}

function copyEnvInto(dest) {
    const src = process.env.DOTENV_PATH || path.join(__dirname, '..', '..', '.env');
    if (fs.existsSync(src)) {
        const text = fs.readFileSync(src, 'utf8');
        const filtered = text.split(/\r?\n/).filter((line) => {
            const key = line.split('=')[0].trim();
            return !key.startsWith('PORTAL_');
        }).join('\n');
        fs.writeFileSync(dest, filtered.endsWith('\n') ? filtered : `${filtered}\n`, 'utf8');
    } else if (!fs.existsSync(dest)) {
        fs.writeFileSync(dest, 'HEADLESS=true\nCONCURRENT_BROWSERS=4\n', 'utf8');
    }
    try { fs.chmodSync(dest, 0o600); } catch (_) {}
}

function createJob({ name, createdBy }) {
    const id = crypto.randomBytes(8).toString('hex');
    const dir = path.join(jobsDir(), id);
    fs.mkdirSync(dir, { recursive: true });
    try { fs.chmodSync(dir, 0o700); } catch (_) {}
    const meta = {
        id,
        name: String(name || 'Workspace').trim().slice(0, 80) || 'Workspace',
        status: 'idle',
        createdBy: createdBy || null,
        startedBy: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        account: null,
        runType: null,
        error: null,
        pid: null,
    };
    writeJson(path.join(dir, 'job.json'), meta);
    writeJson(path.join(dir, 'queue.json'), []);
    copyEnvInto(path.join(dir, '.env'));
    const billingPath = path.join(dir, 'billing_requests.json');
    if (!fs.existsSync(billingPath)) fs.writeFileSync(billingPath, '[]\n', 'utf8');
    ensureRuntime(id);
    return meta;
}

function deleteJob(id) {
    const meta = loadMeta(id);
    if (meta.status === 'running') {
        const err = new Error('Stop the job before deleting it.');
        err.status = 409;
        throw err;
    }
    const rt = runtime.get(id);
    if (rt && rt.child) {
        const err = new Error('Stop the job before deleting it.');
        err.status = 409;
        throw err;
    }
    fs.rmSync(jobDir(id), { recursive: true, force: true });
    runtime.delete(id);
}

function broadcast(id, event, data) {
    const rt = ensureRuntime(id);
    if (event === 'log' && data && data.message) {
        rt.logs.push({ message: data.message, type: data.type || 'info', t: Date.now() });
        if (rt.logs.length > 400) rt.logs.splice(0, rt.logs.length - 400);
    }
    if (event === 'queue' && Array.isArray(data)) {
        rt.queue = data;
        if (rt.queueTimer) clearTimeout(rt.queueTimer);
        rt.queueTimer = setTimeout(() => {
            try { writeJson(queuePath(id), rt.queue); } catch (e) {
                console.warn('[Portal] Queue save failed:', e.message);
            }
        }, 400);
    }
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of rt.subscribers) {
        try { res.write(payload); } catch (_) { rt.subscribers.delete(res); }
    }
}

function sendLive(id, msg) {
    const rt = runtime.get(id);
    if (!rt) return;
    const text = JSON.stringify(msg);
    for (const ws of rt.liveClients) {
        if (ws.readyState === 1) {
            try { ws.send(text); } catch (_) { rt.liveClients.delete(ws); }
        }
    }
}

function runningJobs() {
    return listJobs().filter((j) => j.status === 'running');
}

function sameAccountConflict(account) {
    const key = accountKey(account);
    return runningJobs().filter((j) => accountKey(j.account) === key);
}

function attachChild(id, child) {
    const rt = ensureRuntime(id);
    rt.child = child;
    rt.finished = false;
    rt.stopRequested = false;

    const onLog = (buf, level) => {
        const text = buf.toString('utf8').trim();
        if (!text) return;
        console[level === 'err' ? 'error' : 'log'](`[job ${id}] ${text}`);
    };
    child.stdout.on('data', (buf) => onLog(buf, 'out'));
    child.stderr.on('data', (buf) => onLog(buf, 'err'));

    child.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.channel === 'event') {
            broadcast(id, msg.event, msg.data);
            return;
        }
        if (msg.channel === 'frame') {
            sendLive(id, { type: 'frame', slotId: msg.slotId, data: msg.data, w: msg.w, h: msg.h });
            return;
        }
        if (msg.channel === 'done') {
            finishJob(id, msg.outcome || 'failed', msg.error || null);
        }
    });

    child.on('exit', (code) => {
        const current = runtime.get(id);
        if (!current || current.finished) return;
        finishJob(id, current.stopRequested ? 'stopped' : 'failed', code ? `Job process exited (${code})` : null);
    });
}

function finishJob(id, outcome, error) {
    const rt = runtime.get(id);
    if (!rt || rt.finished) return;
    rt.finished = true;
    rt.child = null;
    let meta;
    try { meta = loadMeta(id); } catch (_) { return; }
    if (meta.status !== 'running' && outcome !== 'stopped') {
        /* already marked */
    }
    const status = outcome === 'completed' || outcome === 'failed' || outcome === 'stopped' || outcome === 'interrupted'
        ? outcome
        : 'failed';
    meta.status = status;
    meta.pid = null;
    meta.error = error || null;
    saveMeta(meta);
    if (rt.queue) {
        try { writeJson(queuePath(id), rt.queue); } catch (_) {}
    }
    broadcast(id, 'automationState', { isRunning: false });
    broadcast(id, 'log', {
        message: status === 'completed'
            ? 'Job finished.'
            : status === 'stopped'
                ? 'Job stopped.'
                : `Job ended: ${error || status}`,
        type: status === 'completed' ? 'success' : 'warning',
    });
}

function startJob(id, prepared, user) {
    const meta = loadMeta(id);
    if (meta.status === 'running') {
        const err = new Error('This job is already running.');
        err.status = 409;
        throw err;
    }
    const running = runningJobs();
    if (running.length >= maxRunningJobs()) {
        const err = new Error(`Already running ${running.length} job(s). The server cap is ${maxRunningJobs()}. Stop one, or raise PORTAL_MAX_JOBS after adding RAM.`);
        err.status = 409;
        throw err;
    }
    const account = prepared.apiConfig && prepared.apiConfig.account;
    const conflicts = sameAccountConflict(account);
    if (conflicts.length && !prepared.confirmSameAccount) {
        const err = new Error(
            `Another running job is already using the ${accountKey(account) === 'brooklyn' ? 'Brooklyn' : 'main'} UniteUs login (${conflicts.map((j) => j.name).join(', ')}). Two jobs on the same login can kick each other off.`
        );
        err.status = 409;
        err.code = 'SAME_ACCOUNT';
        throw err;
    }
    const cap = maxBrowsersPerJob();
    if (prepared.concurrency > cap) {
        prepared.concurrency = cap;
    }
    delete prepared.confirmSameAccount;

    const dir = jobDir(id);
    writeJson(path.join(dir, 'run.json'), prepared);
    if (Array.isArray(prepared.fullQueue)) saveQueue(id, prepared.fullQueue);

    meta.status = 'running';
    meta.runType = prepared.kind === 'insurance' ? 'insurance' : 'billing';
    meta.account = account || meta.account;
    meta.startedBy = user && user.email ? user.email : null;
    meta.error = null;
    meta.startedAt = new Date().toISOString();
    saveMeta(meta);

    const rt = ensureRuntime(id);
    rt.logs = [];
    rt.finished = false;
    rt.stopRequested = false;
    rt.queue = Array.isArray(prepared.fullQueue) ? prepared.fullQueue : rt.queue;

    const runner = path.join(__dirname, '..', 'jobRunner.js');
    const child = spawn(process.execPath, [runner, dir], {
        cwd: path.join(__dirname, '..', '..'),
        env: {
            ...process.env,
            PORTAL_JOB: '1',
            LIVE_VIEW: '1',
            HEADLESS: 'true',
            BILLING_REQUESTS_PATH: path.join(dir, 'billing_requests.json'),
            DOTENV_PATH: path.join(dir, '.env'),
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    meta.pid = child.pid;
    saveMeta(meta);
    attachChild(id, child);
    broadcast(id, 'automationState', { isRunning: true });
    broadcast(id, 'queue', rt.queue);
    return loadMeta(id);
}

function stopJob(id) {
    const meta = loadMeta(id);
    const rt = ensureRuntime(id);
    if (meta.status !== 'running' || !rt.child) {
        if (meta.status === 'running') {
            meta.status = 'interrupted';
            meta.pid = null;
            saveMeta(meta);
        }
        return loadMeta(id);
    }
    rt.stopRequested = true;
    try { rt.child.send({ channel: 'stop' }); } catch (_) {}
    const child = rt.child;
    setTimeout(() => {
        if (child.exitCode == null && !child.killed) {
            try { child.kill('SIGTERM'); } catch (_) {}
        }
    }, 8000);
    setTimeout(() => {
        if (child.exitCode == null && !child.killed) {
            try { child.kill('SIGKILL'); } catch (_) {}
        }
    }, 15000);
    return meta;
}

function sendToJob(id, msg) {
    const rt = runtime.get(id);
    if (!rt || !rt.child || !rt.child.connected) return false;
    try {
        rt.child.send(msg);
        return true;
    } catch (_) {
        return false;
    }
}

function subscribe(id, res) {
    const meta = loadMeta(id);
    const rt = ensureRuntime(id);
    rt.subscribers.add(res);
    const queue = rt.queue || loadQueue(id);
    res.write(`event: queue\ndata: ${JSON.stringify(queue)}\n\n`);
    res.write(`event: automationState\ndata: ${JSON.stringify({ isRunning: meta.status === 'running' })}\n\n`);
    for (const line of rt.logs) {
        res.write(`event: log\ndata: ${JSON.stringify({ message: line.message, type: line.type })}\n\n`);
    }
    return rt;
}

function recoverInterrupted() {
    let changed = 0;
    for (const job of listJobs()) {
        if (job.status !== 'running') continue;
        try {
            const meta = loadMeta(job.id);
            meta.status = 'interrupted';
            meta.pid = null;
            meta.error = 'Server restarted while this job was running. Load the saved session and resume.';
            saveMeta(meta);
            changed += 1;
        } catch (_) {}
    }
    if (changed) console.log(`[Portal] Marked ${changed} job(s) interrupted after restart.`);
}

module.exports = {
    ID_RE,
    dataDir,
    jobDir,
    maxRunningJobs,
    maxBrowsersPerJob,
    accountKey,
    loadMeta,
    saveMeta,
    loadQueue,
    saveQueue,
    summary,
    listJobs,
    createJob,
    deleteJob,
    startJob,
    stopJob,
    sendToJob,
    subscribe,
    broadcast,
    recoverInterrupted,
    counts,
    ensureRuntime,
};
