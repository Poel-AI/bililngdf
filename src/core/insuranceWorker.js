/**
 * Insurance verification worker — same client queue / Unite login as billing,
 * but opens facesheet profile and runs Verify Insurance on each plan card.
 */
const { performLoginSequence } = require('./auth');
const { getPage, restartBrowser } = require('./browser');
const billingSession = require('./billingSession');
const {
    resolveFacesheetFromRequest,
    waitForVerifyInsuranceButtonsReady,
    runInsuranceVerifyInPage,
    flattenInsuranceSummary,
    formatInsuranceMessage,
    formatInsuranceCell,
    insuranceRunSucceeded,
    logLineForPlanEntry,
} = require('./insuranceVerify');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isBrooklynAccount(apiConfig) {
    return (
        apiConfig != null && String(apiConfig.account || '').trim().toLowerCase() === 'brooklyn'
    );
}

function getUniteUsCredentials(apiConfig) {
    if (isBrooklynAccount(apiConfig)) {
        return {
            email: process.env.UNITEUS_EMAIL_BROOKLYN || process.env.UNITEUS_EMAIL,
            password: process.env.UNITEUS_PASSWORD_BROOKLYN || process.env.UNITEUS_PASSWORD,
        };
    }
    return {
        email: process.env.UNITEUS_EMAIL,
        password: process.env.UNITEUS_PASSWORD,
    };
}

function uniteCredsMissingHint(apiConfig) {
    if (isBrooklynAccount(apiConfig)) {
        return ' (Brooklyn: set UNITEUS_EMAIL_BROOKLYN / UNITEUS_PASSWORD_BROOKLYN)';
    }
    return ' (set UNITEUS_EMAIL / UNITEUS_PASSWORD)';
}

async function navigateToFacesheetProfile(page, url, timeoutMs = 90000) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    try {
        await page.waitForLoadState('networkidle', { timeout: 20000 });
    } catch {
        /* Unite keeps polling */
    }
    await sleep(2000);
    await waitForVerifyInsuranceButtonsReady(page, 48000);
}

/**
 * @param {Array} initialRequests
 * @param {function} emitEvent
 * @param {object|null} apiConfig
 * @param {object} options - page, context, requestSlice, slotLabel, slotIndex, sessionQueue, sessionSelectedIds, resume
 */
async function insuranceWorker(initialRequests, emitEvent, apiConfig = null, options = {}) {
    const creds = getUniteUsCredentials(apiConfig);
    if (!creds.email || !creds.password) {
        const hint = uniteCredsMissingHint(apiConfig);
        emitEvent('log', { message: '[AUTH] Missing UniteUs credentials in env.' + hint, type: 'error' });
        return;
    }

    const EMAIL = creds.email;
    const PASSWORD = creds.password;
    const fullRequests = Array.isArray(initialRequests) ? initialRequests : [];
    const toProcess = options.requestSlice || fullRequests;
    const resumeMode = options.resume === true;
    const slotLabel = options.slotLabel || '';
    const slotIndex = options.slotIndex ?? 0;
    const queueForUi = options.sessionQueue || fullRequests;
    const sessionSelectedIds = Array.isArray(options.sessionSelectedIds)
        ? options.sessionSelectedIds.map(String)
        : [];

    const emitSlotStatus = (stage, clientName = '') => {
        emitEvent('slotStatus', { slotIndex, slotLabel, clientName, stage });
    };

    let currentClient = null;
    const emitQueue = () => {
        try {
            billingSession.updateSession('insurance', queueForUi, {
                selectedIds: sessionSelectedIds,
            });
        } catch (e) {
            console.warn('[Session] Could not save insurance progress:', e.message);
        }
        if (currentClient) {
            console.log(
                `[Insurance] ${currentClient.name || currentClient.id || 'client'}: ${currentClient.status || 'pending'}${currentClient.message ? ` (${currentClient.message})` : ''}`
            );
        }
        emitEvent('queue', queueForUi);
    };

    emitEvent('log', {
        message: `${slotLabel ? `[${slotLabel}] ` : ''}Insurance check: ${toProcess.length} client(s)...`,
    });

    let page = options.page != null ? options.page : await getPage();

    const isLoggedIn = async () => {
        try {
            const currentUrl = page.url();
            return currentUrl.includes('uniteus.io') && !currentUrl.includes('auth');
        } catch {
            return false;
        }
    };

    for (let i = 0; i < toProcess.length; i++) {
        const req = toProcess[i];
        currentClient = req;

        if (resumeMode && sessionSelectedIds.length > 0) {
            const sid = String(req.id != null ? req.id : req.orderID || '');
            if (!sessionSelectedIds.includes(sid)) continue;
        }
        if (resumeMode && !billingSession.needsProcessing(req)) continue;

        if (req.skip) {
            req.status = 'skipped';
            emitSlotStatus('Skipped', req.name);
            emitQueue();
            continue;
        }

        delete req.insuranceResults;
        delete req.insuranceContactId;
        delete req.insuranceProfileUrl;
        req.status = 'processing';
        req.message = 'Opening facesheet…';
        emitQueue();
        emitSlotStatus('Starting client', req.name);
        emitEvent('log', {
            message: `${slotLabel ? `[${slotLabel}] ` : ''}Insurance check ${req.name} (${i + 1}/${toProcess.length})`,
        });

        const facesheet = resolveFacesheetFromRequest(req);
        if (!facesheet) {
            req.status = 'failed';
            req.message = 'Insurance: could not parse contact id from Unite link';
            emitSlotStatus('Failed', req.name);
            emitEvent('log', {
                message: `${slotLabel ? `[${slotLabel}] ` : ''}[NAV] No /contact/{uuid} in URL: ${req.url || '(missing)'}`,
                type: 'error',
            });
            emitQueue();
            continue;
        }

        req.insuranceContactId = facesheet.contactId;
        req.insuranceProfileUrl = facesheet.profileUrl;

        let restartAttempt = 0;
        const MAX_RESTARTS = 2;
        let success = false;
        let lastRefreshError = null;

        while (restartAttempt < MAX_RESTARTS && !success) {
            let refreshAttempt = 0;
            const MAX_REFRESHES = 5; // same as billingWorker

            while (refreshAttempt < MAX_REFRESHES && !success) {
                try {
                    if (!(await isLoggedIn())) {
                        emitSlotStatus('UniteUs login', req.name);
                        emitEvent('log', {
                            message: `${slotLabel ? `[${slotLabel}] ` : ''}Logging in...`,
                        });
                        const authOpts =
                            options.page != null && options.context != null
                                ? { page, context: options.context }
                                : {};
                        const loginOk = await performLoginSequence(EMAIL, PASSWORD, authOpts);
                        if (!loginOk) throw new Error('[AUTH] Login failed');
                        await sleep(2000);
                    }

                    const attemptLabel = `(S${restartAttempt + 1}/R${refreshAttempt + 1})`;
                    emitSlotStatus(`Open facesheet ${attemptLabel}`, req.name);
                    req.message = 'Waiting for Verify Insurance buttons…';
                    emitQueue();
                    emitEvent('log', {
                        message: `Navigating to ${facesheet.profileUrl} ${attemptLabel}...`,
                    });
                    await navigateToFacesheetProfile(page, facesheet.profileUrl);
                    emitEvent('log', {
                        message: `${slotLabel ? `[${slotLabel}] ` : ''}Verify Insurance buttons ready — starting checks…`,
                        type: 'info',
                    });

                    req.message = 'Verifying insurance…';
                    req.insuranceResults = [];
                    emitQueue();
                    emitSlotStatus('Verify insurance', req.name);

                    const rawSummary = await runInsuranceVerifyInPage(page, {
                        onPlanDone: async (entry, flatSoFar) => {
                            req.insuranceResults = flatSoFar;
                            req.message = formatInsuranceMessage(flatSoFar);
                            emitQueue();
                            const line = logLineForPlanEntry(entry);
                            const isErr = !!(entry && entry.error);
                            const isRed =
                                !isErr &&
                                Array.isArray(entry.results) &&
                                entry.results.some((r) => String(r.color).toLowerCase() === 'red');
                            emitEvent('log', {
                                message: `${slotLabel ? `[${slotLabel}] ` : ''}${req.name}: ${line}`,
                                type: isErr ? 'error' : isRed ? 'warning' : 'success',
                            });
                            emitSlotStatus(
                                formatInsuranceCell(flatSoFar) || 'Verify insurance',
                                req.name
                            );
                        },
                    });

                    // Empty / not-ready → throw so refresh/restart retries (like billing timeouts)
                    if (!Array.isArray(rawSummary) || rawSummary.length === 0) {
                        const err = new Error('[INSURANCE] No Verify Insurance cards found after wait');
                        err.code = 'INSURANCE_BUTTONS_NOT_READY';
                        throw err;
                    }

                    const flat = flattenInsuranceSummary(rawSummary);
                    const onlyMissing =
                        flat.length === 1 &&
                        flat[0].status === 'ERROR' &&
                        /no verify insurance/i.test(String(flat[0].detail || ''));
                    if (onlyMissing) {
                        const err = new Error('[INSURANCE] No Verify Insurance buttons found after wait');
                        err.code = 'INSURANCE_BUTTONS_NOT_READY';
                        throw err;
                    }

                    req.insuranceResults = flat;
                    req.message = formatInsuranceMessage(flat);
                    emitQueue();

                    if (insuranceRunSucceeded(flat)) {
                        req.status = 'success';
                        emitEvent('log', {
                            message: `${slotLabel ? `[${slotLabel}] ` : ''}✓ ${req.name}: ${req.message}`,
                            type: 'success',
                        });
                    } else {
                        const hasHardError = flat.some((r) => r.status === 'ERROR');
                        req.status = hasHardError ? 'failed' : 'warning';
                        emitEvent('log', {
                            message: `${slotLabel ? `[${slotLabel}] ` : ''}${hasHardError ? '✗' : '⚠'} ${req.name}: ${req.message}`,
                            type: hasHardError ? 'error' : 'warning',
                        });
                    }

                    emitSlotStatus(req.status === 'success' ? 'Done' : 'Finished with issues', req.name);
                    success = true;
                    break;
                } catch (err) {
                    const msg = err && err.message ? err.message : String(err);
                    lastRefreshError = msg;
                    console.error(`[Insurance] ${req.name} attempt failed:`, msg);

                    // Insurance UI loaded but no verify button — skip refresh/restart (won't appear)
                    if (err && err.code === 'INSURANCE_NO_VERIFY_BUTTON') {
                        req.status = 'failed';
                        req.message = msg;
                        req.insuranceResults = [
                            { plan: '', status: 'ERROR', detail: 'Verify Insurance button missing' },
                        ];
                        emitSlotStatus('Failed', req.name);
                        emitEvent('log', {
                            message: `${slotLabel ? `[${slotLabel}] ` : ''}✗ ${req.name}: ${msg}`,
                            type: 'error',
                        });
                        success = true;
                        break;
                    }

                    refreshAttempt += 1;
                    if (refreshAttempt >= MAX_REFRESHES) {
                        emitEvent('log', {
                            message: `${slotLabel ? `[${slotLabel}] ` : ''}Refresh limit reached (${MAX_REFRESHES}).`,
                            type: 'warning',
                        });
                        break;
                    }
                    emitSlotStatus(`Retry: refresh ${refreshAttempt}`, req.name);
                    emitEvent('log', {
                        message: `${slotLabel ? `[${slotLabel}] ` : ''}Refresh attempt ${refreshAttempt}/${MAX_REFRESHES}: ${msg}`,
                        type: 'warning',
                    });
                    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
                    await sleep(2000);
                }
            }

            if (!success) {
                restartAttempt += 1;
                if (restartAttempt < MAX_RESTARTS) {
                    emitSlotStatus(`New browser session ${restartAttempt + 1}/${MAX_RESTARTS}`, req.name);
                    emitEvent('log', {
                        message: `${slotLabel ? `[${slotLabel}] ` : ''}Session failed (${lastRefreshError || 'unknown'}). Restarting browser (Attempt ${restartAttempt + 1}/${MAX_RESTARTS})...`,
                        type: 'warning',
                    });
                    try {
                        if (options.getPageOrRestart) {
                            page = await options.getPageOrRestart();
                        } else {
                            page = await restartBrowser();
                        }
                    } catch (e2) {
                        emitEvent('log', {
                            message: `Browser restart failed: ${e2.message}`,
                            type: 'error',
                        });
                    }
                } else {
                    req.status = 'failed';
                    req.message = `[TIMEOUT] All retry attempts failed${lastRefreshError ? `: ${lastRefreshError}` : ''}`;
                    emitSlotStatus('Failed', req.name);
                    emitEvent('log', {
                        message: `${slotLabel ? `[${slotLabel}] ` : ''}✗ ${req.name}: ${req.message}`,
                        type: 'error',
                    });
                }
            }
        }

        billingSession.clearEphemeralFromRequest(req);
        emitQueue();
        await sleep(500);
    }

    emitSlotStatus('Idle', '');
    emitEvent('log', {
        message: `${slotLabel ? `[${slotLabel}] ` : ''}Insurance check cycle completed.`,
    });
}

module.exports = {
    insuranceWorker,
    resolveFacesheetFromRequest,
};
