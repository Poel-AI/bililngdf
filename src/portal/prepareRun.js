const billingSession = require('../core/billingSession');
const { resolveClientIdForRequest } = require('../core/clientInvoicePdf');

function clampConcurrency(settings, cap) {
    const n = Math.max(1, parseInt(settings.concurrentBrowsers, 10) || 1);
    return Math.min(n, cap);
}

function selectedSetFromBody(body) {
    if (Array.isArray(body.selectedIds) && body.selectedIds.length > 0) {
        return new Set(body.selectedIds.map(String));
    }
    return null;
}

function prepareBilling({ body, queue, session, settings, apiConfig, concurrencyCap, customerApiBase }) {
    const source = body.source || 'queue';
    let requests = [];
    let billingSource = source;
    let fullQueue = Array.isArray(queue) ? queue.map((r) => ({ ...r })) : [];

    if (source === 'resume') {
        if (!session) {
            const err = new Error('No saved billing session to resume.');
            err.status = 404;
            throw err;
        }
        billingSource = session.source || 'queue';
        fullQueue = billingSession.prepareRequestsForResume(session.requests);
        requests = fullQueue.filter((r) => billingSession.needsProcessing(r));
        if (requests.length === 0) {
            const err = new Error('Nothing left to resume.');
            err.status = 400;
            throw err;
        }
    } else if (source === 'queue') {
        if (fullQueue.length === 0) {
            const err = new Error('Queue is empty. Download the client list first.');
            err.status = 400;
            throw err;
        }
        const selectedSet = selectedSetFromBody(body);
        if (!selectedSet) {
            const err = new Error('No clients selected.');
            err.status = 400;
            throw err;
        }
        fullQueue.forEach((r) => {
            r.status = r.status || 'pending';
            r.message = r.message || '';
            const sid = String(r.id != null ? r.id : r.orderID || '');
            if (!selectedSet.has(sid) && (!r.status || r.status === 'pending')) {
                r.status = 'skipped';
                r.message = 'Not selected';
            }
        });
        requests = fullQueue.filter((r) => selectedSet.has(String(r.id != null ? r.id : r.orderID || '')));
        requests = requests.filter((r) => billingSession.needsProcessing(r));
        if (requests.length === 0) {
            const err = new Error('No selected clients waiting to process.');
            err.status = 400;
            throw err;
        }
    } else {
        const err = new Error('This portal runs from the downloaded queue or a saved session.');
        err.status = 400;
        throw err;
    }

    const sessionSettings = source === 'resume' && session && session.runSettings ? session.runSettings : {};
    let customInvoices = typeof body.customInvoices === 'boolean'
        ? body.customInvoices
        : sessionSettings.customInvoices === true;
    const customInvoiceParams = customInvoices
        ? (body.customInvoiceParams || sessionSettings.customInvoiceParams || null)
        : null;
    if (customInvoices && !customInvoiceParams) {
        const err = new Error('Custom invoice mode requires from, to, itemName, quantity, and unitPrice.');
        err.status = 400;
        throw err;
    }
    if (customInvoices) {
        for (const r of requests) {
            const clientId = resolveClientIdForRequest(r, customerApiBase);
            if (!clientId) {
                const err = new Error(`${r.name || 'Client'}: could not parse clientId from API proof link.`);
                err.status = 400;
                throw err;
            }
        }
    }

    const account = (source === 'resume' ? sessionSettings.account : null) || body.account || apiConfig.account;
    const uploadAttestations = typeof body.uploadAttestations === 'boolean'
        ? body.uploadAttestations
        : (sessionSettings.uploadAttestations != null ? sessionSettings.uploadAttestations : settings.uploadAttestations);
    const checkOnlyMode = typeof body.checkOnlyMode === 'boolean'
        ? body.checkOnlyMode
        : (sessionSettings.checkOnlyMode != null ? sessionSettings.checkOnlyMode : settings.checkOnlyMode === true);
    const submitInvoice = typeof body.submitInvoice === 'boolean'
        ? body.submitInvoice
        : (sessionSettings.submitInvoice != null ? sessionSettings.submitInvoice : settings.submitInvoice !== false);
    const skipProduce = typeof body.skipProduce === 'boolean'
        ? body.skipProduce
        : (sessionSettings.skipProduce != null ? sessionSettings.skipProduce : settings.skipProduce === true);
    const skipFood = typeof body.skipFood === 'boolean'
        ? body.skipFood
        : (sessionSettings.skipFood != null ? sessionSettings.skipFood : settings.skipFood === true);
    let dateClampMode = sessionSettings.dateClampMode || settings.dateClampMode || 'auth';
    if (typeof body.dateClampMode === 'string') {
        const v = body.dateClampMode.toLowerCase();
        if (v === 'auth' || v === 'client_created') dateClampMode = v;
    }

    let checkOnlyDebugDates = Array.isArray(sessionSettings.checkOnlyDebugDates) ? sessionSettings.checkOnlyDebugDates : [];
    if (checkOnlyMode && typeof body.checkOnlyDebugDates === 'string' && body.checkOnlyDebugDates.trim()) {
        checkOnlyDebugDates = body.checkOnlyDebugDates.split(',').map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
    }

    const sessionSelectedIds = Array.isArray(body.selectedIds)
        ? body.selectedIds.map(String)
        : (source === 'resume' && session && Array.isArray(session.selectedIds) ? session.selectedIds.map(String) : []);

    const workerOptsBase = {
        uploadAttestations,
        checkOnlyMode,
        checkOnlyDebugDates,
        submitInvoice,
        dateClampMode,
        customInvoices: customInvoices && !!customInvoiceParams,
        customInvoiceParams,
        skipProduce,
        skipFood,
        resume: source === 'resume',
        sessionSelectedIds,
    };
    const runSettings = {
        uploadAttestations,
        checkOnlyMode,
        checkOnlyDebugDates,
        submitInvoice,
        dateClampMode,
        customInvoices: customInvoices && !!customInvoiceParams,
        customInvoiceParams,
        skipProduce,
        skipFood,
        account,
        apiKey: '',
        mode: 'billing',
    };

    return {
        kind: 'billing',
        source,
        billingSource,
        requests,
        fullQueue,
        apiConfig: { ...apiConfig, account: account || apiConfig.account },
        concurrency: clampConcurrency(settings, concurrencyCap),
        workerOptsBase,
        runSettings,
        sessionSelectedIds,
        confirmSameAccount: body.confirmSameAccount === true,
    };
}

function prepareInsurance({ body, queue, settings, apiConfig, concurrencyCap }) {
    const fullQueue = Array.isArray(queue) ? queue.map((r) => ({ ...r })) : [];
    if (fullQueue.length === 0) {
        const err = new Error('Queue is empty. Download the client list first.');
        err.status = 400;
        throw err;
    }
    const selectedSet = selectedSetFromBody(body);
    if (!selectedSet) {
        const err = new Error('No clients selected for insurance check.');
        err.status = 400;
        throw err;
    }
    fullQueue.forEach((r) => {
        const sid = String(r.id != null ? r.id : r.orderID || '');
        if (!selectedSet.has(sid)) {
            if (!r.status || r.status === 'pending') {
                r.status = 'skipped';
                r.message = 'Not selected';
            }
        } else {
            r.status = 'pending';
            r.message = '';
            delete r.insuranceResults;
            delete r.insuranceContactId;
            delete r.insuranceProfileUrl;
        }
    });
    const requests = fullQueue.filter((r) => selectedSet.has(String(r.id != null ? r.id : r.orderID || '')));
    if (requests.length === 0) {
        const err = new Error('No selected clients to check.');
        err.status = 400;
        throw err;
    }
    const account = body.account || apiConfig.account;
    const sessionSelectedIds = [...selectedSet];
    return {
        kind: 'insurance',
        source: 'queue',
        billingSource: 'insurance',
        requests,
        fullQueue,
        apiConfig: { ...apiConfig, account },
        concurrency: clampConcurrency(settings, concurrencyCap),
        workerOptsBase: { sessionSelectedIds },
        runSettings: { account, apiKey: '', mode: 'insurance' },
        sessionSelectedIds,
        confirmSameAccount: body.confirmSameAccount === true,
    };
}

module.exports = { prepareBilling, prepareInsurance };
