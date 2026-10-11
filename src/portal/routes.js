const fs = require('fs');
const path = require('path');
const axios = require('axios');
const express = require('express');
const jobs = require('./jobManager');
const auth = require('./auth');
const { prepareBilling, prepareInsurance } = require('./prepareRun');
const envSettings = require('../envSettings');
const queueExcelExport = require('../core/queueExcelExport');
const insuranceExcelExport = require('../core/insuranceExcelExport');
const queueExcelImport = require('../core/queueExcelImport');
const billingSession = require('../core/billingSession');
const { isBrooklynAccount, logDeliveryDateQueueStats } = require('../core/billingWorker');

function sessionFile(id) {
    return path.join(jobs.jobDir(id), 'billing_session.json');
}

function readSession(id) {
    try {
        const p = sessionFile(id);
        if (!fs.existsSync(p)) return null;
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!data || data.completed || !Array.isArray(data.requests) || data.requests.length === 0) return null;
        return data;
    } catch (_) {
        return null;
    }
}

function sessionSummary(session) {
    if (!session) return null;
    const requests = session.requests || [];
    const done = requests.filter((r) => billingSession.COMPLETED_STATUSES.has(r.status)).length;
    const remaining = billingSession.countRemaining(requests);
    if (remaining === 0) return null;
    return {
        sessionId: session.sessionId,
        source: session.source,
        startedAt: session.startedAt,
        updatedAt: session.updatedAt,
        total: requests.length,
        done,
        remaining,
        interrupted: !!session.interrupted,
    };
}

function envPath(id) {
    return path.join(jobs.jobDir(id), '.env');
}

function assertIdle(id) {
    const meta = jobs.loadMeta(id);
    if (meta.status === 'running') {
        const err = new Error('This job is running. Wait or stop it before changing the queue.');
        err.status = 409;
        throw err;
    }
    return meta;
}

function mount(app, helpers) {
    const {
        mapApiBillRowToQueueRequest,
        buildApiConfig,
        CUSTOMER_API_BASE,
        FETCH_ALL_CLIENTS_TIMEOUT_MS,
    } = helpers;

    app.get('/login', (req, res) => {
        if (auth.userFromRequest(req)) return res.redirect('/jobs');
        res.sendFile(path.join(__dirname, '..', '..', 'public', 'portal', 'login.html'));
    });

    app.get('/jobs', (req, res) => {
        res.sendFile(path.join(__dirname, '..', '..', 'public', 'portal', 'jobs.html'));
    });

    app.get('/users', (req, res) => {
        if (!req.portalUser || req.portalUser.role !== 'admin') return res.redirect('/jobs');
        res.sendFile(path.join(__dirname, '..', '..', 'public', 'portal', 'users.html'));
    });

    app.get('/api/auth/me', (req, res) => {
        res.json({ user: auth.publicUser(req.portalUser) });
    });

    app.post('/api/auth/login', (req, res) => {
        const email = req.body && req.body.email;
        const password = req.body && req.body.password;
        try {
            auth.assertNotLocked(req, email);
            const user = auth.findByEmail(email);
            if (!user || user.disabled || !auth.verifyPassword(password, user.passwordHash)) {
                auth.recordFailure(req, email);
                auth.audit(null, 'login-failed', { email: String(email || '').slice(0, 120) });
                return res.status(401).json({ error: 'Wrong email or password.' });
            }
            auth.clearFailures(req, email);
            auth.setSessionCookie(res, user);
            auth.audit(user, 'login', null);
            res.json({ ok: true, user: auth.publicUser(user) });
        } catch (e) {
            res.status(e.status || 500).json({ error: e.message });
        }
    });

    app.post('/api/auth/totp/setup', async (req, res) => {
        const user = auth.userFromSetupToken(req.body && req.body.setupToken);
        if (!user) return res.status(401).json({ error: 'Setup session expired. Log in again.' });
        const secret = auth.totp.generateSecret();
        auth.updateUser(user.id, (u) => {
            u.totpSecret = secret;
            u.totpEnabled = false;
        });
        const url = auth.totp.otpauthUrl(user.email, secret);
        let qrDataUrl = null;
        try {
            const QRCode = require('qrcode');
            qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 220 });
        } catch (e) {
            console.warn('[Portal] QR code skipped:', e.message);
        }
        res.json({ secret, otpauth: url, qrDataUrl });
    });

    app.post('/api/auth/totp/confirm', (req, res) => {
        const user = auth.userFromSetupToken(req.body && req.body.setupToken);
        if (!user) return res.status(401).json({ error: 'Setup session expired. Log in again.' });
        const fresh = auth.findById(user.id);
        if (!fresh || !fresh.totpSecret) return res.status(400).json({ error: 'Start authenticator setup first.' });
        if (!auth.totp.verifyTotp(fresh.totpSecret, req.body && req.body.code)) {
            return res.status(401).json({ error: 'That code did not match. Check the clock and try again.' });
        }
        const updated = auth.updateUser(fresh.id, (u) => { u.totpEnabled = true; });
        auth.setSessionCookie(res, updated);
        auth.audit(updated, 'totp-enabled', null);
        res.json({ ok: true, user: auth.publicUser(updated) });
    });

    app.post('/api/auth/logout', (req, res) => {
        auth.audit(req.portalUser, 'logout', null);
        res.setHeader('Set-Cookie', auth.clearCookieHeader());
        res.json({ ok: true });
    });

    app.get('/api/users', auth.requireAdmin, (req, res) => {
        res.json({ users: auth.loadUsers().map(auth.publicUser) });
    });

    app.post('/api/users', auth.requireAdmin, (req, res) => {
        try {
            const user = auth.createUser(req.body || {});
            auth.audit(req.portalUser, 'user-create', { email: user.email, role: user.role });
            res.json({ user: auth.publicUser(user) });
        } catch (e) {
            res.status(e.status || 500).json({ error: e.message });
        }
    });

    app.post('/api/users/:id/password', auth.requireAdmin, (req, res) => {
        const password = req.body && req.body.password;
        if (!password || String(password).length < 10) {
            return res.status(400).json({ error: 'Password must be at least 10 characters.' });
        }
        const updated = auth.updateUser(req.params.id, (u) => {
            u.passwordHash = auth.hashPassword(password);
            u.sessionVersion = (u.sessionVersion || 0) + 1;
        });
        if (!updated) return res.status(404).json({ error: 'Unknown user' });
        auth.audit(req.portalUser, 'user-password', { email: updated.email });
        res.json({ user: auth.publicUser(updated) });
    });

    app.post('/api/users/:id/disabled', auth.requireAdmin, (req, res) => {
        const disabled = !!(req.body && req.body.disabled);
        const users = auth.loadUsers();
        const target = users.find((u) => u.id === req.params.id);
        if (!target) return res.status(404).json({ error: 'Unknown user' });
        if (disabled && target.role === 'admin') {
            const admins = users.filter((u) => u.role === 'admin' && !u.disabled && u.id !== target.id);
            if (admins.length === 0) return res.status(400).json({ error: 'Keep at least one admin enabled.' });
        }
        const updated = auth.updateUser(target.id, (u) => {
            u.disabled = disabled;
            if (disabled) u.sessionVersion = (u.sessionVersion || 0) + 1;
        });
        auth.audit(req.portalUser, disabled ? 'user-disable' : 'user-enable', { email: updated.email });
        res.json({ user: auth.publicUser(updated) });
    });

    app.get('/api/jobs', (req, res) => {
        res.json({
            jobs: jobs.listJobs(),
            caps: { maxJobs: jobs.maxRunningJobs(), maxBrowsers: jobs.maxBrowsersPerJob() },
        });
    });

    app.post('/api/jobs', (req, res) => {
        const meta = jobs.createJob({
            name: req.body && req.body.name,
            createdBy: req.portalUser && req.portalUser.email,
        });
        auth.audit(req.portalUser, 'job-create', { id: meta.id, name: meta.name });
        res.json({ job: jobs.summary(meta, []) });
    });

    app.delete('/api/jobs/:id', (req, res) => {
        try {
            const meta = jobs.loadMeta(req.params.id);
            jobs.deleteJob(req.params.id);
            auth.audit(req.portalUser, 'job-delete', { id: meta.id, name: meta.name });
            res.json({ ok: true });
        } catch (e) {
            res.status(e.status || 500).json({ error: e.message });
        }
    });

    app.get('/api/jobs/:id', (req, res) => {
        try {
            const meta = jobs.loadMeta(req.params.id);
            res.json({ job: jobs.summary(meta), queue: jobs.loadQueue(req.params.id) });
        } catch (e) {
            res.status(e.status || 500).json({ error: e.message });
        }
    });

    app.post('/api/jobs/:id/stop', (req, res) => {
        try {
            const meta = jobs.stopJob(req.params.id);
            auth.audit(req.portalUser, 'job-stop', { id: meta.id });
            res.json({ ok: true, job: jobs.summary(meta) });
        } catch (e) {
            res.status(e.status || 500).json({ error: e.message });
        }
    });

    app.get('/api/jobs/:id/events', (req, res) => {
        try {
            jobs.loadMeta(req.params.id);
        } catch (e) {
            return res.status(e.status || 500).json({ error: e.message });
        }
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            Connection: 'keep-alive',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
        });
        const rt = jobs.subscribe(req.params.id, res);
        const ping = setInterval(() => {
            try { res.write(': ping\n\n'); } catch (_) {}
        }, 20000);
        req.on('close', () => {
            clearInterval(ping);
            rt.subscribers.delete(res);
        });
    });

    function jobSettings(id) {
        const meta = jobs.loadMeta(id);
        const s = envSettings.readSettings(envPath(id));
        const cap = jobs.maxBrowsersPerJob();
        return {
            ...s,
            concurrentBrowsers: Math.min(s.concurrentBrowsers, cap),
            appMode: 'billing',
            appDisplayName: meta.name || 'Diet Fantasy',
            insuranceOnly: false,
            isRunning: meta.status === 'running',
            portalMode: true,
            minConcurrent: 1,
            maxConcurrent: cap,
        };
    }

    app.get('/api/jobs/:id/api/settings', (req, res) => {
        try {
            res.json(jobSettings(req.params.id));
        } catch (e) {
            res.status(e.status || 500).json({ error: e.message });
        }
    });

    app.post('/api/jobs/:id/api/settings', (req, res) => {
        try {
            const meta = jobs.loadMeta(req.params.id);
            if (meta.status === 'running') {
                return res.status(409).json({ error: 'Automation is running; wait for it to finish before changing settings.' });
            }
            const body = req.body || {};
            const updates = {};
            for (const key of [
                'concurrentBrowsers', 'headless', 'uploadAttestations', 'checkOnlyMode',
                'checkOnlyMultiDateDebug', 'checkOnlyDebugDates', 'submitInvoice', 'dateClampMode',
                'billFromInvoices', 'customInvoices', 'skipProduce', 'skipFood',
            ]) {
                if (body[key] != null) updates[key] = body[key];
            }
            if (Object.keys(updates).length === 0) {
                return res.status(400).json({ error: 'No settings to update' });
            }
            if (updates.concurrentBrowsers != null) {
                updates.concurrentBrowsers = Math.min(parseInt(updates.concurrentBrowsers, 10) || 1, jobs.maxBrowsersPerJob());
            }
            envSettings.writeSettings(updates, envPath(req.params.id));
            auth.audit(req.portalUser, 'job-settings', { id: req.params.id });
            res.json({ ...jobSettings(req.params.id), isRunning: false });
        } catch (e) {
            res.status(e.status || 500).json({ error: e.message });
        }
    });

    app.post('/api/jobs/:id/api/open-env-folder', (req, res) => {
        res.status(400).json({ error: 'Source files stay on the server. Download the Excel export instead.' });
    });

    app.get('/api/jobs/:id/api/billing-session', (req, res) => {
        try {
            const meta = jobs.loadMeta(req.params.id);
            if (meta.status === 'running') return res.json({ session: null, running: true, selectedIds: [] });
            const raw = readSession(req.params.id);
            res.json({
                session: sessionSummary(raw),
                running: false,
                selectedIds: raw && Array.isArray(raw.selectedIds) ? raw.selectedIds.map(String) : [],
            });
        } catch (e) {
            res.status(e.status || 500).json({ error: e.message });
        }
    });

    app.post('/api/jobs/:id/load-billing-session', (req, res) => {
        try {
            assertIdle(req.params.id);
            const raw = readSession(req.params.id);
            if (!raw) return res.status(404).json({ error: 'No saved billing session found.' });
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
            jobs.saveQueue(req.params.id, requests);
            jobs.broadcast(req.params.id, 'queue', requests);
            const summary = sessionSummary(readSession(req.params.id)) || sessionSummary({ ...raw, requests });
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
            res.status(e.status || 500).json({ error: e.message });
        }
    });

    app.post('/api/jobs/:id/clear-billing-session', (req, res) => {
        try {
            assertIdle(req.params.id);
            const p = sessionFile(req.params.id);
            if (fs.existsSync(p)) fs.unlinkSync(p);
            res.json({ success: true, message: 'Saved session cleared.' });
        } catch (e) {
            res.status(e.status || 500).json({ error: e.message });
        }
    });

    app.get('/api/jobs/:id/api/export-queue.xlsx', (req, res) => {
        try {
            const queue = jobs.loadQueue(req.params.id);
            if (!queue.length) return res.status(400).json({ error: 'No queue loaded. Download clients from the server first.' });
            const buf = queueExcelExport.buildQueueWorkbookBuffer(queue);
            auth.audit(req.portalUser, 'export-queue', { id: req.params.id });
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${queueExcelExport.downloadFilenameStamp()}"`);
            res.send(buf);
        } catch (e) {
            res.status(e.status || 500).json({ error: e.message });
        }
    });

    app.get('/api/jobs/:id/api/export-insurance.xlsx', (req, res) => {
        try {
            const queue = jobs.loadQueue(req.params.id);
            if (!queue.length) return res.status(400).json({ error: 'No queue loaded. Download clients from the server first.' });
            const buf = insuranceExcelExport.buildInsuranceWorkbookBuffer(queue);
            auth.audit(req.portalUser, 'export-insurance', { id: req.params.id });
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${insuranceExcelExport.downloadFilenameStamp()}"`);
            res.send(buf);
        } catch (e) {
            res.status(e.status || 500).json({ error: e.message });
        }
    });

    app.post(
        '/api/jobs/:id/api/import-queue-from-excel',
        express.raw({
            type: [
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'application/octet-stream',
            ],
            limit: '25mb',
        }),
        (req, res) => {
        try {
            assertIdle(req.params.id);
            let buf = null;
            if (Buffer.isBuffer(req.body) && req.body.length) buf = req.body;
            else if (req.body && req.body.fileBase64) buf = Buffer.from(req.body.fileBase64, 'base64');
            if (!buf || !buf.length) return res.status(400).json({ error: 'Empty or missing Excel file in request body.' });
            const onlyRemaining = !(req.body && req.body.onlyRemaining === false);
            const queue = jobs.loadQueue(req.params.id);
            const downloaded = queueExcelImport.loadDownloadedClientsJson(jobs.jobDir(req.params.id), 'downloaded_clients.json');
            const settings = envSettings.readSettings(envPath(req.params.id));
            const source = queue.slice();
            if (Array.isArray(downloaded) && downloaded.length) {
                downloaded.forEach((row, i) => {
                    source.push(mapApiBillRowToQueueRequest(row, i, { billFromInvoices: settings.billFromInvoices !== false }));
                });
            }
            const result = queueExcelImport.importQueueFromExcelBuffer(buf, source, { onlyRemaining });
            if (!result.ok) return res.status(400).json({ error: result.error, missing: result.missing || [] });
            const p = sessionFile(req.params.id);
            if (fs.existsSync(p)) fs.unlinkSync(p);
            jobs.saveQueue(req.params.id, result.queue);
            jobs.broadcast(req.params.id, 'queue', result.queue);
            auth.audit(req.portalUser, 'import-queue', { id: req.params.id, imported: result.imported });
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
            res.status(e.status || 500).json({ error: e.message });
        }
    });

    app.post('/api/jobs/:id/fetch-all-clients', async (req, res) => {
        try {
            const meta = assertIdle(req.params.id);
            const dateParam = (req.body && req.body.date) ? String(req.body.date).trim() : null;
            const endDateParam = (req.body && req.body.endDate) ? String(req.body.endDate).trim() : null;
            const accountParam = (req.body && req.body.account) ? String(req.body.account).trim().toLowerCase() : null;
            const params = new URLSearchParams();
            if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) params.set('date', dateParam);
            if (endDateParam && /^\d{4}-\d{2}-\d{2}$/.test(endDateParam)) params.set('endDate', endDateParam);
            const allowedAccounts = new Set(['regular', 'brooklyn', 'yonkers', 'both', 'main']);
            if (accountParam && allowedAccounts.has(accountParam)) {
                params.set('account', accountParam === 'main' ? 'regular' : accountParam);
            }
            const qs = params.toString();
            const base = CUSTOMER_API_BASE.replace(/\/$/, '');
            const settings = envSettings.readSettings(envPath(req.params.id));
            const billFromInvoices = settings.billFromInvoices !== false;
            const pathSegment = billFromInvoices ? '/api/bill/invoices' : '/api/bill';
            const url = `${base}${pathSegment}${qs ? '?' + qs : ''}`;
            const { data } = await axios.get(url, { timeout: FETCH_ALL_CLIENTS_TIMEOUT_MS });
            if (!Array.isArray(data)) return res.status(500).json({ error: `Expected array from ${pathSegment}` });
            const requests = data.map((r, i) => mapApiBillRowToQueueRequest(r, i, {
                billFromInvoices,
                listStartDate: dateParam,
                listEndDate: endDateParam,
            }));
            try {
                logDeliveryDateQueueStats('portal fetch-all-clients', requests, {
                    endpoint: pathSegment,
                    brooklynMode: isBrooklynAccount({ account: accountParam, baseUrl: base }),
                });
            } catch (_) {}
            const rawPath = path.join(jobs.jobDir(req.params.id), 'downloaded_clients.json');
            fs.writeFileSync(rawPath, JSON.stringify(data, null, 2), 'utf8');
            jobs.saveQueue(req.params.id, requests);
            jobs.broadcast(req.params.id, 'queue', requests);
            meta.account = accountParam || meta.account;
            jobs.saveMeta(meta);
            auth.audit(req.portalUser, 'fetch-clients', { id: req.params.id, count: requests.length, account: accountParam });
            res.json({
                success: true,
                count: requests.length,
                billFromInvoices,
                fetchPath: pathSegment,
                message: `Loaded ${requests.length} clients from ${pathSegment}.`,
            });
        } catch (e) {
            const status = e.status || (e.response ? 502 : 500);
            const message = e.response ? `${e.response.status}: ${JSON.stringify(e.response.data)}` : e.message;
            res.status(status).json({ error: message });
        }
    });

    function begin(id, prepared, user) {
        const meta = jobs.startJob(id, prepared, user);
        auth.audit(user, 'job-start', { id, kind: prepared.kind, account: prepared.apiConfig && prepared.apiConfig.account });
        return meta;
    }

    app.post('/api/jobs/:id/process-billing', (req, res) => {
        try {
            const id = req.params.id;
            const body = req.body || {};
            const settings = envSettings.readSettings(envPath(id));
            const queue = jobs.loadQueue(id);
            const session = body.source === 'resume' ? readSession(id) : null;
            const account = body.account || (session && session.runSettings && session.runSettings.account) || null;
            const apiConfig = buildApiConfig(body.apiKey, account);
            const prepared = prepareBilling({
                body,
                queue,
                session,
                settings,
                apiConfig,
                concurrencyCap: jobs.maxBrowsersPerJob(),
                customerApiBase: CUSTOMER_API_BASE,
            });
            begin(id, prepared, req.portalUser);
            res.json({
                message: body.source === 'resume' ? 'Resume started.' : 'Automation started',
                source: prepared.billingSource,
                resume: body.source === 'resume',
            });
        } catch (e) {
            res.status(e.status || 500).json({ error: e.message, code: e.code || undefined });
        }
    });

    app.post('/api/jobs/:id/process-insurance', (req, res) => {
        try {
            const id = req.params.id;
            const body = req.body || {};
            const settings = envSettings.readSettings(envPath(id));
            const queue = jobs.loadQueue(id);
            const apiConfig = buildApiConfig(body.apiKey, body.account);
            const prepared = prepareInsurance({
                body,
                queue,
                settings,
                apiConfig,
                concurrencyCap: jobs.maxBrowsersPerJob(),
            });
            begin(id, prepared, req.portalUser);
            res.json({ message: 'Insurance check started', count: prepared.requests.length });
        } catch (e) {
            res.status(e.status || 500).json({ error: e.message, code: e.code || undefined });
        }
    });
}

module.exports = { mount };
