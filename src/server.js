const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { launchBrowser, launchBrowserInstance, closeAllBrowserInstances } = require('./core/browser');
const { billingWorker, fetchRequestsFromApi, extractDeliveryDateFromRow, logDeliveryDateQueueStats, isBrooklynAccount } = require('./core/billingWorker');
const billingSession = require('./core/billingSession');
const queueExcelExport = require('./core/queueExcelExport');
const queueExcelImport = require('./core/queueExcelImport');
const envSettings = require('./envSettings');
const { safeLoadDotenv } = require('./safeDotenv');

/** Client list and billing API always use this host; Brooklyn vs Main is ?account= only. */
const CUSTOMER_API_BASE = 'https://customer.thedietfantasy.com';

/** Rewrite legacy Diet Fantasy hosts in API-returned URLs (brooklyn/monsey → customer). */
function normalizeCustomerApiUrl(urlStr) {
    if (urlStr == null || typeof urlStr !== 'string') return urlStr;
    const t = urlStr.trim();
    if (!t || !/thedietfantasy\.com/i.test(t)) return urlStr;
    return t.replace(/https?:\/\/(?:brooklyn|monsey)\.thedietfantasy\.com/gi, CUSTOMER_API_BASE);
}

function normalizeUrlList(urls) {
    if (!Array.isArray(urls)) return [];
    return urls.map((u) => normalizeCustomerApiUrl(u));
}

function buildApiConfig(apiKey, account) {
    const baseUrl = CUSTOMER_API_BASE.replace(/\/$/, '');
    const accountNorm = account != null && String(account).trim() !== ''
        ? String(account).trim().toLowerCase()
        : null;
    return { baseUrl, key: apiKey, account: accountNorm };
}

// Settings UI persists CONCURRENT_BROWSERS / HEADLESS to the same .env as DOTENV_PATH (see electron-main).

// Load .env from DOTENV_PATH (packaged app) or project root
const dotenvPath = process.env.DOTENV_PATH || path.join(__dirname, '..', '.env');
safeLoadDotenv(dotenvPath);

const { install: installLogger, installCrashHandlers, getLogPath } = require('./core/logger');
try {
    installLogger();
    installCrashHandlers();
} catch (e) {
    try { console.warn('[Server] Logger init failed:', e.message); } catch (_) {}
}
console.log('[Server] Log file:', getLogPath());

try {
    billingSession.compactSessionFileIfNeeded();
} catch (e) {
    console.warn('[Server] Session compaction skipped:', e.message);
}

/** Comma-separated YYYY-MM-DD for check-only multi-date debug (deduped, order preserved). */
function parseCheckOnlyDebugDates(str) {
    if (str == null || typeof str !== 'string') return [];
    const seen = new Set();
    const out = [];
    for (const part of str.split(',')) {
        const s = part.trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
    }
    return out;
}

/** Writable app folder — same directory as billing_requests.json / .env (userData when packaged). */
function getAppDataDir() {
    const billingPath = process.env.BILLING_REQUESTS_PATH || path.join(__dirname, '..', 'billing_requests.json');
    return path.dirname(billingPath);
}

const DOWNLOADED_CLIENTS_JSON = 'downloaded_clients.json';

/** Write the raw API client-list array to disk for debugging / comparison across machines. */
function saveDownloadedClientsJson(rawRows) {
    const dir = getAppDataDir();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const filePath = path.join(dir, DOWNLOADED_CLIENTS_JSON);
    const rows = Array.isArray(rawRows) ? rawRows : [];
    fs.writeFileSync(filePath, JSON.stringify(rows, null, 2), 'utf8');
    console.log(`[Server] Saved ${rows.length} row(s) to ${filePath}`);
    return filePath;
}

/** Split array into N slices (round-robin) so each slot gets different clients. */
function roundRobinSlices(arr, n) {
    const slices = Array.from({ length: n }, () => []);
    arr.forEach((item, i) => slices[i % n].push(item));
    return slices;
}

const app = express();
const PORT = process.env.PORT || 3500;

app.use(express.json());
// Serve static frontend
app.use(express.static(path.join(__dirname, '../public')));

// -- SSE Setup --
let clients = [];

function eventsHandler(req, res) {
    const headers = {
        'Content-Type': 'text/event-stream',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache'
    };
    res.writeHead(200, headers);

    const clientId = Date.now();
    const newClient = { id: clientId, res };
    clients.push(newClient);

    // Send initial queue state if exists
    if (currentRequests) {
        res.write(`event: queue\ndata: ${JSON.stringify(currentRequests)}\n\n`);
    }

    // Idle slot strip: configured browser slots from .env
    try {
        const s = envSettings.readSettings();
        res.write(`event: slotCount\ndata: ${JSON.stringify({ count: s.concurrentBrowsers })}\n\n`);
    } catch (e) {
        console.warn('[SSE] slotCount init:', e.message);
    }

    req.on('close', () => {
        clients = clients.filter(c => c.id !== clientId);
    });
}

function broadcast(type, data) {
    if (type === 'log' && data && data.message) {
        const level = data.type === 'error' ? 'error' : data.type === 'warning' ? 'warn' : 'log';
        console[level](`[Run] ${data.message}`);
    }
    clients.forEach(client => {
        client.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    });
}

app.get('/events', eventsHandler);

app.get('/api/billing-session', (req, res) => {
    try {
        if (isRunning) {
            return res.json({ session: null, running: true, selectedIds: [] });
        }
        const session = billingSession.getSessionSummary();
        const raw = billingSession.loadSession();
        res.json({
            session,
            running: false,
            selectedIds: raw && Array.isArray(raw.selectedIds) ? raw.selectedIds.map(String) : [],
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/load-billing-session', (req, res) => {
    try {
        const raw = billingSession.loadSession();
        if (!raw) {
            return res.status(404).json({ error: 'No saved billing session found.' });
        }
        const requests = billingSession.prepareRequestsForResume(raw.requests);
        const selectedSet = new Set(Array.isArray(raw.selectedIds) ? raw.selectedIds.map(String) : []);
        requests.forEach((r) => {
            r.status = r.status || 'pending';
            r.message = r.message || '';
            const sid = String(r.id != null ? r.id : r.orderID || '');
            if (selectedSet.size > 0 && !selectedSet.has(sid) && r.status === 'pending') {
                r.status = 'skipped';
                r.message = 'Not selected';
            }
        });
        currentRequests = requests;
        broadcast('queue', currentRequests);
        const summary = billingSession.getSessionSummary();
        console.log(`[Server] Loaded billing session (${requests.length} clients, ${summary ? summary.remaining : 0} remaining)`);
        res.json({
            success: true,
            count: requests.length,
            session: summary,
            selectedIds: Array.isArray(raw.selectedIds) ? raw.selectedIds.map(String) : [],
            message: summary
                ? `Loaded saved session: ${summary.done} done, ${summary.remaining} remaining.`
                : `Loaded saved session (${requests.length} clients).`,
        });
    } catch (e) {
        console.error('[Server] load-billing-session Error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/clear-billing-session', (req, res) => {
    try {
        billingSession.clearSession();
        res.json({ success: true, message: 'Saved session cleared.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// State
let isRunning = false;
let currentRequests = null;

// --- Settings (.env), open folder, Excel export ---
app.get('/api/settings', (req, res) => {
    try {
        const s = envSettings.readSettings();
        res.json({
            ...s,
            isRunning,
            minConcurrent: envSettings.MIN_CONCURRENT,
            maxConcurrent: envSettings.MAX_CONCURRENT
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/settings', (req, res) => {
    if (isRunning) {
        return res.status(409).json({ error: 'Automation is running; wait for it to finish before changing settings.' });
    }
    const body = req.body || {};
    const hasConcurrent = body.concurrentBrowsers != null;
    const hasHeadless = body.headless != null;
    const hasUploadAttestations = body.uploadAttestations != null;
    const hasCheckOnlyMode = body.checkOnlyMode != null;
    const hasCheckOnlyMultiDateDebug = body.checkOnlyMultiDateDebug != null;
    const hasCheckOnlyDebugDates = body.checkOnlyDebugDates != null;
    const hasSubmitInvoice = body.submitInvoice != null;
    const hasDateClampMode = body.dateClampMode != null;
    const hasBillFromInvoices = body.billFromInvoices != null;
    if (
        !hasConcurrent &&
        !hasHeadless &&
        !hasUploadAttestations &&
        !hasCheckOnlyMode &&
        !hasCheckOnlyMultiDateDebug &&
        !hasCheckOnlyDebugDates &&
        !hasSubmitInvoice &&
        !hasDateClampMode &&
        !hasBillFromInvoices
    ) {
        return res.status(400).json({
            error: 'Provide concurrentBrowsers, headless, uploadAttestations, checkOnlyMode, checkOnlyMultiDateDebug, checkOnlyDebugDates, submitInvoice, dateClampMode, and/or billFromInvoices'
        });
    }
    try {
        const updates = {};
        if (hasConcurrent) updates.concurrentBrowsers = body.concurrentBrowsers;
        if (hasHeadless) updates.headless = body.headless;
        if (hasUploadAttestations) updates.uploadAttestations = body.uploadAttestations;
        if (hasCheckOnlyMode) updates.checkOnlyMode = body.checkOnlyMode;
        if (hasCheckOnlyMultiDateDebug) updates.checkOnlyMultiDateDebug = body.checkOnlyMultiDateDebug;
        if (hasCheckOnlyDebugDates) updates.checkOnlyDebugDates = body.checkOnlyDebugDates;
        if (hasSubmitInvoice) updates.submitInvoice = body.submitInvoice;
        if (hasDateClampMode) updates.dateClampMode = body.dateClampMode;
        if (hasBillFromInvoices) updates.billFromInvoices = body.billFromInvoices;
        const saved = envSettings.writeSettings(updates);
        res.json({ ...saved, isRunning });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/open-env-folder', (req, res) => {
    try {
        envSettings.openEnvFolder();
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/export-queue.xlsx', (req, res) => {
    const queue = Array.isArray(currentRequests) ? currentRequests : [];
    if (queue.length === 0) {
        return res.status(400).json({ error: 'No queue loaded. Download clients from the server first.' });
    }
    const buf = queueExcelExport.buildQueueWorkbookBuffer(queue);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader(
        'Content-Disposition',
        `attachment; filename="${queueExcelExport.downloadFilenameStamp()}"`
    );
    res.send(buf);
});

/** Merge in-memory queue with remapped downloaded_clients.json for Excel import matching. */
function buildSourceQueueForImport() {
    let billFromInvoices = true;
    try {
        billFromInvoices = envSettings.readSettings().billFromInvoices !== false;
    } catch (_) { /* defaults */ }

    const merged = [];
    const seen = new Set();
    const add = (r) => {
        if (!r) return;
        const key = r.clientId
            ? `c:${String(r.clientId).toLowerCase()}`
            : r.url
              ? `u:${String(r.url).trim().toLowerCase()}`
              : r.id
                ? `i:${String(r.id)}`
                : null;
        if (key && seen.has(key)) return;
        if (key) seen.add(key);
        merged.push(r);
    };

    if (Array.isArray(currentRequests)) {
        currentRequests.forEach(add);
    }

    const raw = queueExcelImport.loadDownloadedClientsJson(getAppDataDir(), DOWNLOADED_CLIENTS_JSON);
    if (raw && raw.length) {
        const remapped = raw.map((r, i) => {
            const orderURLs = normalizeUrlList(r.orderURLs);
            const proofURLs = normalizeUrlList(r.proofURLs);
            const rawUrl = r.url || (orderURLs[0]) || null;
            return {
                id: `bill-${i + 1}`,
                clientId: r.clientId || null,
                name: r.name,
                url: normalizeCustomerApiUrl(rawUrl),
                date: r.date,
                endDate: r.endDate,
                deliveryDate: extractDeliveryDateFromRow(r),
                amount: r.amount,
                dependants: r.dependants || [],
                orderNumbers: Array.isArray(r.orderNumbers) ? r.orderNumbers : [],
                orderURLs,
                proofURLs,
                proofURL: normalizeCustomerApiUrl(proofURLs[0] || null),
                createdAt: r.createdAt ?? r.created_at ?? r['Created At'] ?? null,
                useClientInvoicePdf: billFromInvoices === true,
                status: 'pending',
                message: '',
            };
        });
        remapped.forEach(add);
    }

    return merged;
}

app.post('/api/import-queue-from-excel', express.json({ limit: '15mb' }), (req, res) => {
    if (isRunning) {
        return res.status(409).json({ error: 'Billing is running. Stop or wait for the run to finish before importing.' });
    }
    try {
        const fileBase64 = req.body && req.body.fileBase64;
        if (!fileBase64 || typeof fileBase64 !== 'string') {
            return res.status(400).json({ error: 'Missing fileBase64 in request body.' });
        }
        const buf = Buffer.from(fileBase64, 'base64');
        if (!buf.length) {
            return res.status(400).json({ error: 'Empty file.' });
        }

        const sourceQueue = buildSourceQueueForImport();
        const result = queueExcelImport.importQueueFromExcelBuffer(buf, sourceQueue, {
            onlyRemaining: req.body.onlyRemaining !== false,
        });
        if (!result.ok) {
            return res.status(400).json({ error: result.error, missing: result.missing || [] });
        }

        billingSession.clearSession();
        currentRequests = result.queue;
        broadcast('queue', currentRequests);

        const statusNote = Object.entries(result.statusCounts || {})
            .map(([k, n]) => `${k}: ${n}`)
            .join(', ');
        console.log(
            `[Server] Imported ${result.imported} client(s) from Excel (${statusNote}). Session cleared for clean run.`
        );

        res.json({
            success: true,
            imported: result.imported,
            excelRowCount: result.excelRowCount,
            filteredRowCount: result.filteredRowCount,
            statusCounts: result.statusCounts,
            selectedIds: result.selectedIds,
            queue: result.queue,
            missing: result.missing || [],
            message: `Loaded ${result.imported} client(s) from Excel for a clean run. All set to pending — click Run billing.`,
        });
    } catch (e) {
        console.error('[Server] import-queue-from-excel Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Routes
app.post('/fetch-requests', async (req, res) => {
    const { apiBaseUrl, apiKey } = req.body;
    const apiConfig = (apiBaseUrl) ? { baseUrl: apiBaseUrl, key: apiKey } : null;

    try {
        console.log('[Server] Fetching requests from API (Preview Mode)...');
        const requests = await fetchRequestsFromApi(apiConfig);

        if (!requests || requests.length === 0) {
            return res.json({ success: true, count: 0, message: 'No pending requests found.' });
        }

        // Initialize status and stable id for selection
        requests.forEach((r, i) => {
            r.status = 'pending';
            r.message = '';
            if (r.id == null) r.id = r.orderID ? String(r.orderID) : `api-${i}`;
        });
        currentRequests = requests;
        broadcast('queue', currentRequests);

        res.json({ success: true, count: requests.length, message: `Loaded ${requests.length} requests.` });
    } catch (e) {
        console.error('[Server] Fetch Preview Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Pull clients from GET /api/bill/invoices?date=… (default) or GET /api/bill (legacy). No auth. Optional &account=regular|brooklyn|both.
app.post('/fetch-all-clients', async (req, res) => {
    const dateParam = (req.body && req.body.date) ? String(req.body.date).trim() : null;
    const accountParam = (req.body && req.body.account) ? String(req.body.account).trim().toLowerCase() : null;
    const params = new URLSearchParams();
    if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
        params.set('date', dateParam);
    }
    const allowedAccounts = new Set(['regular', 'brooklyn', 'both']);
    if (accountParam && allowedAccounts.has(accountParam)) {
        params.set('account', accountParam);
    }
    const qs = params.toString();
    const base = CUSTOMER_API_BASE.replace(/\/$/, '');
    let billFromInvoices = true;
    try {
        billFromInvoices = envSettings.readSettings().billFromInvoices !== false;
    } catch (e) {
        console.warn('[Server] readSettings for billFromInvoices:', e.message);
    }
    const pathSegment = billFromInvoices ? '/api/bill/invoices' : '/api/bill';
    const url = `${base}${pathSegment}${qs ? '?' + qs : ''}`;
    try {
        console.log('[Server] Fetching all clients from', url);
        console.log('[DATES] fetch-all-clients config:', JSON.stringify({
            apiBaseUrl: base,
            account: accountParam || '(default)',
            billDate: dateParam || '(none)',
            billFromInvoices,
            envFile: envSettings.getEnvFilePath?.() || process.env.DOTENV_PATH || '(default)',
            brooklynProcessingMode: isBrooklynAccount({ account: accountParam, baseUrl: base })
        }));
        const { data } = await axios.get(url, { timeout: 30000 });
        if (!Array.isArray(data)) {
            return res.status(500).json({ error: `Expected array from ${pathSegment}` });
        }
        if (data.length > 0) {
            const sampleRaw = data[0];
            const dateLikeKeys = Object.keys(sampleRaw).filter((k) => /date|delivery|service/i.test(k));
            console.log('[DATES] Raw API sample row date-like keys:', dateLikeKeys.join(', ') || '(none)');
            console.log('[DATES] Raw API sample values:', JSON.stringify(
                dateLikeKeys.reduce((acc, k) => { acc[k] = sampleRaw[k]; return acc; }, { name: sampleRaw.name })
            ));
        }
        const requests = data.map((r, i) => {
            const orderURLs = normalizeUrlList(r.orderURLs);
            const proofURLs = normalizeUrlList(r.proofURLs);
            const rawUrl = r.url || (orderURLs[0]) || null;
            return {
            id: `bill-${i + 1}`,
            clientId: r.clientId || null,
            name: r.name,
            url: normalizeCustomerApiUrl(rawUrl),
            date: r.date,
            endDate: r.endDate,
            deliveryDate: extractDeliveryDateFromRow(r),
            amount: r.amount,
            dependants: r.dependants || [],
            orderNumbers: Array.isArray(r.orderNumbers) ? r.orderNumbers : [],
            orderURLs,
            proofURLs,
            proofURL: normalizeCustomerApiUrl(proofURLs[0] || null),
            createdAt: r.createdAt ?? r.created_at ?? r['Created At'] ?? null,
            useClientInvoicePdf: billFromInvoices === true,
            status: 'pending',
            message: ''
        };
        });
        logDeliveryDateQueueStats('after fetch-all-clients map', requests, {
            endpoint: pathSegment,
            brooklynMode: isBrooklynAccount({ account: accountParam, baseUrl: base })
        });
        const savedJsonPath = saveDownloadedClientsJson(data);
        currentRequests = requests;
        broadcast('queue', currentRequests);
        const label = billFromInvoices ? '/api/bill/invoices' : '/api/bill';
        res.json({
            success: true,
            count: requests.length,
            billFromInvoices,
            fetchPath: pathSegment,
            savedJsonPath,
            message: `Loaded ${requests.length} clients from ${label}. Raw JSON saved to ${savedJsonPath}.`
        });
    } catch (e) {
        console.error('[Server] Fetch client list Error:', e.message);
        res.status(500).json({ error: e.response ? `${e.response.status}: ${JSON.stringify(e.response.data)}` : e.message });
    }
});

app.post('/process-billing', async (req, res) => {
    if (isRunning) {
        return res.status(409).json({ message: 'Process already running' });
    }

    const { source = 'file', apiKey, account } = req.body;

    let requests = [];
    let billingSource = source;

    try {
        if (source === 'resume') {
            const raw = billingSession.loadSession();
            if (!raw) {
                return res.status(404).json({ error: 'No saved billing session to resume.' });
            }
            billingSource = raw.source || 'queue';
            requests = billingSession.prepareRequestsForResume(raw.requests);
            requests.forEach((r) => { r.status = r.status || 'pending'; r.message = r.message || ''; });
            currentRequests = requests;
            broadcast('queue', currentRequests);
            const summary = billingSession.getSessionSummary();
            broadcast('log', {
                message: summary
                    ? `Resuming saved session: ${summary.done} already done, ${summary.remaining} to process.`
                    : `Resuming saved session (${requests.length} clients).`,
                type: 'info',
            });
        } else if (source === 'file') {
            // -- SOURCE: FILE --
            const jsonPath = process.env.BILLING_REQUESTS_PATH || path.join(__dirname, '../billing_requests.json');
            if (!fs.existsSync(jsonPath)) {
                return res.status(404).json({ error: 'billing_requests.json not found' });
            }
            const data = fs.readFileSync(jsonPath, 'utf8');
            requests = JSON.parse(data);

            // Validate that we have an array
            if (!Array.isArray(requests)) {
                return res.status(500).json({ error: 'billing_requests.json must contain an array' });
            }
            if (requests.length === 0) {
                return res.status(400).json({ error: 'No requests found in billing_requests.json' });
            }

            // Initialize status for UI
            requests.forEach(r => { r.status = 'pending'; r.message = ''; });
            currentRequests = requests;
            broadcast('queue', currentRequests);
        } else if (source === 'queue') {
            // -- SOURCE: QUEUE (current in-memory list, e.g. from "Download from /api/bill") --
            let queueList = Array.isArray(currentRequests) ? currentRequests : [];
            if (queueList.length === 0) {
                return res.status(400).json({ error: 'Queue is empty. Use "Download from /api/bill" or "Download from Cloud" first.' });
            }
            queueList.forEach(r => { r.status = r.status || 'pending'; r.message = r.message || ''; });
            const { selectedIndices, selectedIds } = req.body || {};
            let selectedSet = null;
            if (Array.isArray(selectedIds) && selectedIds.length > 0) {
                selectedSet = new Set(selectedIds.map(String));
            } else if (Array.isArray(selectedIndices) && selectedIndices.length > 0) {
                requests = queueList.filter((_, i) => selectedIndices.includes(i));
            }
            if (selectedSet) {
                queueList.forEach((r) => {
                    const sid = String(r.id != null ? r.id : r.orderID || '');
                    if (!selectedSet.has(sid) && (!r.status || r.status === 'pending')) {
                        r.status = 'skipped';
                        r.message = 'Not selected';
                    }
                });
                requests = queueList.filter((r) => selectedSet.has(String(r.id != null ? r.id : r.orderID || '')));
            } else if (!Array.isArray(selectedIndices) || selectedIndices.length === 0) {
                requests = queueList;
            }
            requests = (requests || []).filter((r) => billingSession.needsProcessing(r));
            if (requests.length === 0) {
                return res.status(400).json({ error: 'No selected clients waiting to process.' });
            }
            broadcast('log', {
                message: `Run billing: ${requests.length} selected client(s) to process.`,
                type: 'info',
            });
            broadcast('queue', queueList);
        } else {
            // -- SOURCE: API (billing-requests) --
            // We set currentRequests to empty or null so UI knows something is happening but waiting for data
            currentRequests = [];
            broadcast('log', { message: 'Mode: API. Fetching pending requests...', type: 'info' });
        }

    } catch (e) {
        console.error('[Server] Setup Error:', e);
        return res.status(500).json({ error: `Setup failed: ${e.message}` });
    }

    console.log(`[Server] Starting automation (Source: ${billingSource}${source === 'resume' ? ', resume' : ''})`);
    if (source === 'queue' && requests.length > 0) {
        logDeliveryDateQueueStats('process-billing queue slice', requests, {
            apiBaseUrl: CUSTOMER_API_BASE,
            account: account || '(none)',
            brooklynMode: isBrooklynAccount({ account, baseUrl: CUSTOMER_API_BASE }),
            selectedCount: requests.length,
            queueTotal: Array.isArray(currentRequests) ? currentRequests.length : 0
        });
    }
    res.json({ message: 'Automation started', source: billingSource, resume: source === 'resume' });

    isRunning = true;
    broadcast('automationState', { isRunning: true });
    broadcast('log', { message: `--- Starting Automation Run (${billingSource}${source === 'resume' ? ', resume' : ''}) ---`, type: 'info' });

    const sessionRaw = source === 'resume' ? billingSession.loadSession() : null;
    const resumeAccount = sessionRaw?.runSettings?.account ?? account;
    const resumeApiKey = sessionRaw?.runSettings?.apiKey ?? apiKey;

    // API config for update-status: queue/api always use customer host + ?account=
    const apiConfig = (billingSource === 'api' || billingSource === 'queue' || source === 'resume')
        ? buildApiConfig(resumeApiKey, resumeAccount)
        : null;

    const workerRequests = (billingSource === 'file' || billingSource === 'queue' || source === 'resume') ? requests : null;

    const settingsSnapshot = envSettings.readSettings();
    const concurrency = Math.max(1, settingsSnapshot.concurrentBrowsers);
    let uploadAttestations = sessionRaw?.runSettings?.uploadAttestations ?? settingsSnapshot.uploadAttestations;
    if (req.body && typeof req.body.uploadAttestations === 'boolean') {
        uploadAttestations = req.body.uploadAttestations;
    }
    let checkOnlyMode = sessionRaw?.runSettings?.checkOnlyMode ?? settingsSnapshot.checkOnlyMode === true;
    if (req.body && typeof req.body.checkOnlyMode === 'boolean') {
        checkOnlyMode = req.body.checkOnlyMode;
    }

    let submitInvoice = sessionRaw?.runSettings?.submitInvoice ?? settingsSnapshot.submitInvoice !== false;
    if (req.body && typeof req.body.submitInvoice === 'boolean') {
        submitInvoice = req.body.submitInvoice;
    }

    let dateClampMode = sessionRaw?.runSettings?.dateClampMode ?? (settingsSnapshot.dateClampMode || envSettings.DEFAULT_DATE_CLAMP_MODE);
    if (req.body && typeof req.body.dateClampMode === 'string') {
        const v = req.body.dateClampMode.toLowerCase();
        if (envSettings.VALID_DATE_CLAMP_MODES.has(v)) dateClampMode = v;
    }

    let checkOnlyDebugDates = Array.isArray(sessionRaw?.runSettings?.checkOnlyDebugDates)
        ? sessionRaw.runSettings.checkOnlyDebugDates
        : [];
    if (checkOnlyMode) {
        const fromBody =
            req.body && typeof req.body.checkOnlyDebugDates === 'string' ? req.body.checkOnlyDebugDates : '';
        if (fromBody.trim()) {
            checkOnlyDebugDates = parseCheckOnlyDebugDates(fromBody);
        } else if (
            settingsSnapshot.checkOnlyMultiDateDebug === true &&
            typeof settingsSnapshot.checkOnlyDebugDates === 'string' &&
            settingsSnapshot.checkOnlyDebugDates.trim()
        ) {
            checkOnlyDebugDates = parseCheckOnlyDebugDates(settingsSnapshot.checkOnlyDebugDates);
        }
    }

    const sessionSelectedIds = Array.isArray(req.body?.selectedIds)
        ? req.body.selectedIds.map((id) => String(id))
        : (source === 'resume' && sessionRaw?.selectedIds ? sessionRaw.selectedIds.map(String) : []);

    const workerOptsBase = {
        uploadAttestations,
        checkOnlyMode,
        checkOnlyDebugDates,
        submitInvoice,
        dateClampMode,
        resume: source === 'resume',
        sessionQueue: currentRequests,
        sessionSelectedIds,
    };
    const runSettings = {
        uploadAttestations,
        checkOnlyMode,
        checkOnlyDebugDates,
        submitInvoice,
        dateClampMode,
        account: resumeAccount,
        apiKey: resumeApiKey || '',
    };
    const maybeStartSession = (reqs) => {
        if (!Array.isArray(reqs) || reqs.length === 0) return;
        const extra = { runSettings, selectedIds: sessionSelectedIds, inProgress: true, interrupted: false };
        if (source === 'resume') {
            billingSession.updateSession(billingSource, reqs, extra);
        } else {
            billingSession.startSession(billingSource, reqs, extra);
        }
    };

    (async () => {
        let runCompletedSuccessfully = false;
        try {
            broadcast('slotCount', { count: concurrency });
            if (!uploadAttestations) {
                broadcast('log', { message: 'Proof / attestation upload is off for this run — skipping API PDF and Unite attach step.', type: 'info' });
            }
            if (checkOnlyMode) {
                broadcast('log', {
                    message:
                        'Check-only mode is ON — no billing will be created. Counts fee-schedule cards whose service delivery range starts on each date checked (end date ignored).',
                    type: 'info'
                });
                if (checkOnlyDebugDates.length > 0) {
                    broadcast('log', {
                        message: `Check-only multi-date: ${checkOnlyDebugDates.join(', ')} (overrides each client’s server start).`,
                        type: 'info'
                    });
                }
            }
            if (!checkOnlyMode && !submitInvoice) {
                broadcast('log', {
                    message:
                        'Submit invoice is OFF (testing) — the billing form will be filled but Post will not be clicked; a Continue bar appears at the top of the page until you click it.',
                    type: 'warning'
                });
            }
            if (dateClampMode === 'client_created') {
                broadcast('log', {
                    message:
                        'Date clamping: Client created mode — validates JSON created-at vs case Date Opened and billing week; skips edge cases with warnings.',
                    type: 'info'
                });
            }
            if (concurrency === 1) {
                maybeStartSession(currentRequests);
                await launchBrowser();
                await billingWorker(workerRequests, broadcast, billingSource, apiConfig, {
                    slotIndex: 0,
                    slotLabel: 'Slot 0',
                    ...workerOptsBase,
                });
            } else {
                broadcast('log', { message: `Starting ${concurrency} browsers in parallel (different clients per slot)...`, type: 'info' });
                let requests = workerRequests;
                if (billingSource === 'api') {
                    requests = await fetchRequestsFromApi(apiConfig);
                    if (!requests || requests.length === 0) {
                        broadcast('log', { message: 'No pending requests from API.', type: 'warning' });
                        isRunning = false;
                        return;
                    }
                }
                if (!requests || requests.length === 0) {
                    broadcast('log', { message: 'No requests to process.', type: 'warning' });
                    isRunning = false;
                    return;
                }
                if (billingSource === 'api') {
                    requests.forEach((r, i) => {
                        r.status = r.status || 'pending';
                        r.message = r.message || '';
                        if (r.id == null) r.id = r.orderID ? String(r.orderID) : `api-${i}`;
                    });
                    currentRequests = requests;
                    broadcast('queue', currentRequests);
                }
                maybeStartSession(currentRequests);

                const slices = roundRobinSlices(requests, concurrency);
                const slots = await Promise.all(
                    Array.from({ length: concurrency }, (_, i) => launchBrowserInstance(i))
                );
                await Promise.all(
                    slots.map((slot, i) =>
                        billingWorker(requests, broadcast, billingSource, apiConfig, {
                            page: slot.page,
                            context: slot.context,
                            getPageOrRestart: slot.restartPage,
                            requestSlice: slices[i],
                            slotIndex: i,
                            slotLabel: `Slot ${i}`,
                            ...workerOptsBase,
                        })
                    )
                );
                await closeAllBrowserInstances();
            }
            broadcast('log', { message: '--- Automation Run Complete ---', type: 'success' });
            runCompletedSuccessfully = true;
        } catch (e) {
            console.error('CRITICAL AUTOMATION ERROR:', e);
            broadcast('log', { message: `Critical Error: ${e.message}`, type: 'error' });
            try {
                await closeAllBrowserInstances();
            } catch (e2) {
                console.warn('Close all instances:', e2.message);
            }
        } finally {
            if (runCompletedSuccessfully) {
                const exportResult = queueExcelExport.saveQueueExcelToDisk(currentRequests || []);
                if (exportResult.ok) {
                    broadcast('log', {
                        message: `Excel auto-saved: ${exportResult.path}`,
                        type: 'success',
                    });
                } else {
                    broadcast('log', {
                        message: `Excel auto-save failed: ${exportResult.error}`,
                        type: 'warning',
                    });
                }
            }
            isRunning = false;
            billingSession.finalizeSession(currentRequests || []);
            broadcast('automationState', { isRunning: false });
        }
    })();
});

function start(port) {
    const p = port != null ? port : PORT;
    return app.listen(p, () => {
        console.log(`Server running on http://localhost:${p}`);
    });
}

module.exports = { app, start };

if (require.main === module) {
    start(PORT);
}
