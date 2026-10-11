/**
 * UniteUs facesheet insurance verification helpers.
 * Case URL: .../cases/open/{caseId}/contact/{contactId}
 * Profile:  .../facesheet/{contactId}/profile
 */

const FACESHEET_PROFILE_BASE = 'https://app.uniteus.io/facesheet';

/** UUID after /contact/ in a Unite case/dashboard URL. */
function extractContactIdFromUniteUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const m = url.trim().match(/\/contact\/([0-9a-f-]{36})\b/i);
    return m ? m[1] : null;
}

function buildFacesheetProfileUrl(contactId) {
    if (!contactId) return null;
    return `${FACESHEET_PROFILE_BASE}/${contactId}/profile`;
}

/**
 * Resolve facesheet profile URL from a queue row's Unite case link.
 * @returns {{ contactId: string, profileUrl: string } | null}
 */
function resolveFacesheetFromRequest(req) {
    const url = req && req.url != null ? String(req.url).trim() : '';
    const contactId = extractContactIdFromUniteUrl(url);
    if (!contactId) return null;
    return { contactId, profileUrl: buildFacesheetProfileUrl(contactId) };
}

async function scanInsurancePageState(page) {
    try {
        return await page.evaluate(() => {
            const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
            const bodyText = norm(document.body && document.body.textContent);

            const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter(
                (el) => el.textContent.trim() === 'Verify Insurance'
            );
            let withPlan = 0;
            for (const btn of buttons) {
                let node = btn;
                while (node && !node.textContent.includes('Plan Name')) node = node.parentElement;
                if (node) withPlan += 1;
            }

            const hasPlanName = /Plan Name/i.test(bodyText);
            const hasMemberId = /Member ID/i.test(bodyText);
            const hasInsuranceHeading = /\bInsurance\b/i.test(bodyText);
            // Section looks hydrated when plan fields are on the page (button may still be absent)
            const sectionLoaded = hasPlanName && (hasMemberId || hasInsuranceHeading);

            return {
                buttons: buttons.length,
                withPlan,
                hasPlanName,
                hasMemberId,
                sectionLoaded,
            };
        });
    } catch {
        return {
            buttons: 0,
            withPlan: 0,
            hasPlanName: false,
            hasMemberId: false,
            sectionLoaded: false,
        };
    }
}

async function countVerifyInsuranceButtons(page) {
    const s = await scanInsurancePageState(page);
    return { buttons: s.buttons, withPlan: s.withPlan };
}

async function scrollInsuranceSectionIntoView(page) {
    try {
        await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button, a, [role="button"]')).find(
                (el) => el.textContent.trim() === 'Verify Insurance'
            );
            const planEl = Array.from(document.querySelectorAll('*')).find(
                (el) =>
                    el.childNodes.length &&
                    /Plan Name/i.test(el.textContent || '') &&
                    (el.textContent || '').length < 500
            );
            const target = btn || planEl;
            if (target) target.scrollIntoView({ block: 'center', inline: 'center' });
        });
    } catch {
        /* ignore */
    }
}

/**
 * Poll until "Verify Insurance" buttons are ready.
 * If insurance plan info is already on the page but the button never appears,
 * fail fast (no long wait / refresh) — refreshing won't create a missing button.
 * @returns {{ buttons: number, withPlan: number }}
 */
async function waitForVerifyInsuranceButtonsReady(page, timeoutMs = 48000) {
    await scrollInsuranceSectionIntoView(page);
    const deadline = Date.now() + timeoutMs;
    /** How long sectionLoaded+no-button must hold before we give up (avoid racing late button paint). */
    const noButtonConfirmMs = 4000;
    let noButtonSince = null;
    let last = {
        buttons: 0,
        withPlan: 0,
        hasPlanName: false,
        hasMemberId: false,
        sectionLoaded: false,
    };

    while (Date.now() < deadline) {
        last = await scanInsurancePageState(page);

        if (last.withPlan > 0) {
            console.log(
                `[Insurance] Verify Insurance buttons ready: buttons=${last.buttons} withPlan=${last.withPlan}`
            );
            return { buttons: last.buttons, withPlan: last.withPlan };
        }

        if (last.sectionLoaded && last.buttons === 0) {
            if (noButtonSince == null) noButtonSince = Date.now();
            if (Date.now() - noButtonSince >= noButtonConfirmMs) {
                console.warn(
                    '[Insurance] Insurance section loaded but no Verify Insurance button — failing fast (skip refresh)'
                );
                const err = new Error(
                    '[INSURANCE] Insurance info is visible but Verify Insurance button is missing (not available for this client)'
                );
                err.code = 'INSURANCE_NO_VERIFY_BUTTON';
                throw err;
            }
        } else {
            noButtonSince = null;
        }

        if (Date.now() + 2000 > deadline) {
            await scrollInsuranceSectionIntoView(page);
        }
        await new Promise((r) => setTimeout(r, 350));
    }

    console.warn(
        `[Insurance] Timed out waiting for Verify Insurance buttons (${timeoutMs}ms): buttons=${last.buttons} withPlan=${last.withPlan} sectionLoaded=${last.sectionLoaded}`
    );
    const err = new Error(
        `[INSURANCE] Verify Insurance buttons not ready after ${timeoutMs}ms (found ${last.buttons} button(s), ${last.withPlan} with Plan Name)`
    );
    err.code = 'INSURANCE_BUTTONS_NOT_READY';
    throw err;
}

/**
 * Click every "Verify Insurance" card; stream each plan via onPlanDone (live UI).
 * Uses one in-page pass (stable card list) + exposeFunction for progress.
 */
async function runInsuranceVerifyInPage(page, { perCardTimeoutMs = 25000, onPlanDone } = {}) {
    // Ensure buttons are still present right before clicking (hydration can lag after nav wait)
    await waitForVerifyInsuranceButtonsReady(page, 30000);

    const bindingName = `__insurancePlanDone_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const summary = [];

    const handler = async (entry) => {
        summary.push(entry);
        const flatSoFar = flattenInsuranceSummary(summary);
        if (typeof onPlanDone === 'function') {
            await onPlanDone(entry, flatSoFar);
        }
    };

    // Prefer context binding so it survives soft navigations; fall back to page
    const ctx = typeof page.context === 'function' ? page.context() : null;
    if (ctx && typeof ctx.exposeBinding === 'function') {
        await ctx.exposeBinding(bindingName, async (_source, entry) => handler(entry));
    } else {
        await page.exposeFunction(bindingName, handler);
    }

    const prevTimeout = 30000;
    const evalTimeout = Math.max(180000, perCardTimeoutMs * 10);
    if (typeof page.setDefaultTimeout === 'function') {
        page.setDefaultTimeout(evalTimeout);
    }

    try {
        const result = await page.evaluate(
            async ({ timeoutMs, reportFn }) => {
                const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
                const report = async (entry) => {
                    try {
                        await window[reportFn](entry);
                    } catch (_) {
                        /* binding may be gone */
                    }
                };

                function findCards() {
                    const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter(
                        (el) => el.textContent.trim() === 'Verify Insurance'
                    );
                    return buttons
                        .map((btn) => {
                            let node = btn;
                            while (node && !node.textContent.includes('Plan Name')) node = node.parentElement;
                            return { container: node };
                        })
                        .filter((c) => c.container);
                }

                function getPlanName(container) {
                    const m = container.textContent.match(/Plan Name(.*?)Member ID/);
                    return m ? m[1].trim() : '(unknown plan)';
                }

                function getButtonIn(container) {
                    return Array.from(container.querySelectorAll('button, a, [role="button"]')).find(
                        (el) =>
                            el.textContent.trim() === 'Verify Insurance' || /verifying/i.test(el.textContent)
                    );
                }

                function extractResults(container) {
                    const icons = Array.from(
                        container.querySelectorAll('svg[class*="text-green"], svg[class*="text-red"]')
                    );
                    return icons.map((icon) => {
                        const cls = icon.getAttribute('class') || '';
                        const color = cls.includes('text-green') ? 'green' : 'red';
                        const text = icon.parentElement ? icon.parentElement.textContent.trim() : '';
                        return { color, text };
                    });
                }

                async function waitUntilDone(container, timeout) {
                    await sleep(400);
                    const start = Date.now();
                    while (Date.now() - start < timeout) {
                        const btn = getButtonIn(container);
                        const stillLoading =
                            (btn && /verifying/i.test(btn.textContent)) ||
                            (btn && btn.disabled) ||
                            /verifying/i.test(container.textContent);
                        if (!stillLoading) return true;
                        await sleep(400);
                    }
                    return false;
                }

                const cards = findCards();
                const localSummary = [];

                for (const { container } of cards) {
                    const plan = getPlanName(container);
                    const btn = getButtonIn(container);
                    let entry;
                    if (!btn) {
                        entry = { plan, error: 'button not found' };
                    } else {
                        btn.click();
                        const finished = await waitUntilDone(container, timeoutMs);
                        if (!finished) {
                            entry = { plan, error: 'timed out waiting for result' };
                        } else {
                            entry = { plan, results: extractResults(container) };
                        }
                    }
                    localSummary.push(entry);
                    await report(entry);
                    await sleep(300);
                }

                window.__insuranceVerifyResults = localSummary;
                return localSummary;
            },
            { timeoutMs: perCardTimeoutMs, reportFn: bindingName }
        );

        // Prefer in-page return if binding missed anything
        if (Array.isArray(result) && result.length > summary.length) {
            return result;
        }
        return summary.length > 0 ? summary : result || [];
    } finally {
        if (typeof page.setDefaultTimeout === 'function') {
            page.setDefaultTimeout(prevTimeout);
        }
        try {
            await page.evaluate((name) => {
                try {
                    delete window[name];
                } catch (_) {}
            }, bindingName);
        } catch {
            /* ignore */
        }
    }
}

/** Flatten verify summary into rows suitable for Excel / UI. */
function flattenInsuranceSummary(summary) {
    if (!Array.isArray(summary) || summary.length === 0) {
        return [{ plan: '', status: 'ERROR', detail: 'No Verify Insurance buttons found' }];
    }
    const rows = [];
    for (const s of summary) {
        if (s.error) {
            rows.push({ plan: s.plan || '', status: 'ERROR', detail: s.error });
            continue;
        }
        const results = Array.isArray(s.results) ? s.results : [];
        if (results.length === 0) {
            rows.push({ plan: s.plan || '', status: 'ERROR', detail: 'no results after verify' });
            continue;
        }
        for (const r of results) {
            rows.push({
                plan: s.plan || '',
                status: String(r.color || '').toUpperCase() || 'UNKNOWN',
                detail: r.text || '',
            });
        }
    }
    return rows;
}

function formatInsuranceMessage(flatRows) {
    if (!Array.isArray(flatRows) || flatRows.length === 0) return 'Insurance: no results';
    return (
        'Insurance: ' +
        flatRows
            .map((r) => `${r.plan || '?'}: ${r.status}${r.detail ? ` — ${r.detail}` : ''}`)
            .join('; ')
    );
}

/** Compact cell text for the queue Insurance column. */
function formatInsuranceCell(flatRows) {
    if (!Array.isArray(flatRows) || flatRows.length === 0) return '';
    return flatRows.map((r) => `${r.plan || '?'}: ${r.status}`).join(' · ');
}

function insuranceRunSucceeded(flatRows) {
    if (!Array.isArray(flatRows) || flatRows.length === 0) return false;
    return flatRows.every((r) => r.status === 'GREEN');
}

function logLineForPlanEntry(entry) {
    if (!entry) return 'Insurance plan: (empty)';
    if (entry.error) return `${entry.plan || '?'}: ERROR — ${entry.error}`;
    const results = Array.isArray(entry.results) ? entry.results : [];
    if (results.length === 0) return `${entry.plan || '?'}: ERROR — no results`;
    return results
        .map((r) => `${entry.plan || '?'}: ${String(r.color || '').toUpperCase()} — ${r.text || ''}`)
        .join('; ');
}

module.exports = {
    FACESHEET_PROFILE_BASE,
    extractContactIdFromUniteUrl,
    buildFacesheetProfileUrl,
    resolveFacesheetFromRequest,
    countVerifyInsuranceButtons,
    scanInsurancePageState,
    waitForVerifyInsuranceButtonsReady,
    runInsuranceVerifyInPage,
    flattenInsuranceSummary,
    formatInsuranceMessage,
    formatInsuranceCell,
    insuranceRunSucceeded,
    logLineForPlanEntry,
};
