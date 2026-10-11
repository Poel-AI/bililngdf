/**
 * Runs one prepared billing or insurance job.
 * Called from the portal job child process (src/jobRunner.js), which owns
 * BILLING_REQUESTS_PATH / DOTENV_PATH for this job's folder.
 */
const { launchBrowser, launchBrowserInstance, closeAllBrowserInstances, closeBrowser } = require('./browser');
const { billingWorker, fetchRequestsFromApi } = require('./billingWorker');
const { insuranceWorker } = require('./insuranceWorker');
const billingSession = require('./billingSession');
const queueExcelExport = require('./queueExcelExport');
const insuranceExcelExport = require('./insuranceExcelExport');

function roundRobinSlices(arr, n) {
    const slices = Array.from({ length: n }, () => []);
    arr.forEach((item, i) => slices[i % n].push(item));
    return slices;
}

async function shutdownBrowsers() {
    try {
        await closeAllBrowserInstances();
    } catch (e) {
        console.warn('[Run] Close instances:', e.message);
    }
    try {
        await closeBrowser();
    } catch (e) {
        console.warn('[Run] Close browser:', e.message);
    }
}

async function executePreparedRun(prepared, broadcast, abort) {
    const kind = prepared.kind === 'insurance' ? 'insurance' : 'billing';
    const fullQueue = Array.isArray(prepared.fullQueue) ? prepared.fullQueue : [];
    let requests = Array.isArray(prepared.requests) ? prepared.requests : [];
    const billingSource = prepared.billingSource || (kind === 'insurance' ? 'insurance' : 'queue');
    const apiConfig = prepared.apiConfig || null;
    const concurrency = Math.max(1, parseInt(prepared.concurrency, 10) || 1);
    const workerOptsBase = prepared.workerOptsBase || {};
    workerOptsBase.sessionQueue = fullQueue;
    const source = prepared.source || 'queue';
    const runSettings = prepared.runSettings || {};
    const sessionSelectedIds = Array.isArray(prepared.sessionSelectedIds)
        ? prepared.sessionSelectedIds.map(String)
        : [];

    const stopped = () => abort && abort.requested;

    const maybeStartSession = (reqs) => {
        if (!Array.isArray(reqs) || reqs.length === 0) return;
        const extra = { runSettings, selectedIds: sessionSelectedIds, inProgress: true, interrupted: false };
        if (source === 'resume') {
            billingSession.updateSession(billingSource, reqs, extra);
        } else {
            billingSession.startSession(kind === 'insurance' ? 'insurance' : billingSource, reqs, extra);
        }
    };

    let runCompletedSuccessfully = false;
    let outcome = 'failed';
    try {
        broadcast('slotCount', { count: concurrency });
        if (kind === 'billing') {
            if (workerOptsBase.uploadAttestations === false) {
                broadcast('log', { message: 'Proof / attestation upload is off for this run — skipping API PDF and Unite attach step.', type: 'info' });
            }
            if (workerOptsBase.customInvoices && workerOptsBase.customInvoiceParams && workerOptsBase.uploadAttestations !== false) {
                broadcast('log', {
                    message: 'Custom invoice mode — proof PDFs from /api/client-invoice-pdf.',
                    type: 'info',
                });
            }
            if (workerOptsBase.checkOnlyMode) {
                broadcast('log', {
                    message: 'Check-only mode is ON — no billing will be created.',
                    type: 'info',
                });
            }
            if (!workerOptsBase.checkOnlyMode && workerOptsBase.submitInvoice === false) {
                broadcast('log', {
                    message: 'Submit invoice is OFF — the form will be filled but Post will not be clicked. Use the live view to click Continue.',
                    type: 'warning',
                });
            }
            if (workerOptsBase.skipProduce && !workerOptsBase.checkOnlyMode) {
                broadcast('log', { message: 'Skip produce is ON.', type: 'info' });
            }
            if (workerOptsBase.skipFood && !workerOptsBase.checkOnlyMode) {
                broadcast('log', { message: 'Skip food is ON.', type: 'info' });
            }
        } else {
            broadcast('log', { message: '--- Starting Insurance Verification ---', type: 'info' });
        }

        if (stopped()) {
            outcome = 'stopped';
            return outcome;
        }

        if (concurrency === 1) {
            maybeStartSession(fullQueue);
            await launchBrowser();
            if (stopped()) {
                outcome = 'stopped';
                return outcome;
            }
            if (kind === 'insurance') {
                await insuranceWorker(requests, broadcast, apiConfig, {
                    slotIndex: 0,
                    slotLabel: 'Slot 0',
                    ...workerOptsBase,
                });
            } else {
                await billingWorker(requests, broadcast, billingSource, apiConfig, {
                    slotIndex: 0,
                    slotLabel: 'Slot 0',
                    ...workerOptsBase,
                });
            }
        } else {
            broadcast('log', {
                message: `Starting ${concurrency} browsers in parallel (different clients per slot)...`,
                type: 'info',
            });
            if (kind === 'billing' && billingSource === 'api') {
                requests = await fetchRequestsFromApi(apiConfig);
                if (!requests || requests.length === 0) {
                    broadcast('log', { message: 'No pending requests from API.', type: 'warning' });
                    outcome = 'completed';
                    return outcome;
                }
                requests.forEach((r, i) => {
                    r.status = r.status || 'pending';
                    r.message = r.message || '';
                    if (r.id == null) r.id = r.orderID ? String(r.orderID) : `api-${i}`;
                });
                fullQueue.splice(0, fullQueue.length, ...requests);
                broadcast('queue', fullQueue);
            }
            if (!requests || requests.length === 0) {
                broadcast('log', { message: 'No requests to process.', type: 'warning' });
                outcome = 'completed';
                return outcome;
            }
            maybeStartSession(fullQueue);
            if (stopped()) {
                outcome = 'stopped';
                return outcome;
            }
            const slices = roundRobinSlices(requests, concurrency);
            const slots = await Promise.all(
                Array.from({ length: concurrency }, (_, i) => launchBrowserInstance(i))
            );
            if (stopped()) {
                outcome = 'stopped';
                return outcome;
            }
            const runSlot = (slot, i) => {
                const opts = {
                    page: slot.page,
                    context: slot.context,
                    getPageOrRestart: slot.restartPage,
                    requestSlice: slices[i],
                    slotIndex: i,
                    slotLabel: `Slot ${i}`,
                    ...workerOptsBase,
                };
                if (kind === 'insurance') return insuranceWorker(requests, broadcast, apiConfig, opts);
                return billingWorker(requests, broadcast, billingSource, apiConfig, opts);
            };
            await Promise.all(slots.map((slot, i) => runSlot(slot, i)));
        }

        if (stopped()) {
            outcome = 'stopped';
            broadcast('log', { message: 'Run stopped.', type: 'warning' });
            return outcome;
        }

        broadcast('log', {
            message: kind === 'insurance' ? '--- Insurance Verification Complete ---' : '--- Automation Run Complete ---',
            type: 'success',
        });
        runCompletedSuccessfully = true;
        outcome = 'completed';
    } catch (e) {
        if (stopped()) {
            outcome = 'stopped';
            broadcast('log', { message: 'Run stopped.', type: 'warning' });
        } else {
            console.error('CRITICAL AUTOMATION ERROR:', e);
            broadcast('log', { message: `Critical Error: ${e.message}`, type: 'error' });
            outcome = 'failed';
        }
    } finally {
        await shutdownBrowsers();
        if (runCompletedSuccessfully) {
            const exportResult = kind === 'insurance'
                ? insuranceExcelExport.saveInsuranceExcelToDisk(fullQueue)
                : queueExcelExport.saveQueueExcelToDisk(fullQueue);
            if (exportResult.ok) {
                broadcast('log', { message: `Excel auto-saved: ${exportResult.path}`, type: 'success' });
            } else {
                broadcast('log', { message: `Excel auto-save failed: ${exportResult.error}`, type: 'warning' });
            }
        }
        billingSession.finalizeSession(fullQueue);
        broadcast('queue', fullQueue);
        broadcast('automationState', { isRunning: false });
    }
    return outcome;
}

module.exports = { executePreparedRun, roundRobinSlices };
