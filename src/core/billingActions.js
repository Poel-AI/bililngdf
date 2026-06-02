// This module contains the complex DOM interactions ported from the extension.
// It uses page.evaluate() to inject the exact same robust logic into the browser.
// All element IDs/XPaths/classes come from uniteSelectors.billing (single source of truth).

const uniteSelectors = require('../uniteSelectors');

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until Unite has rendered fee-schedule cards and at least one card shows cost or
 * service delivery dates (React hydration / lazy list).
 */
async function waitForUniteFeeScheduleCardsReady(page, sel, timeoutMs = 48000) {
    const scan = sel.duplicateScan || {};
    const cardClass = (scan.cardClass || 'fee-schedule-provided-service-card').replace(/^\./, '');
    const amountTest = scan.amountDataTest || 'unit-amount-value';
    const deadline = Date.now() + timeoutMs;
    let last = { cards: 0, dated: 0, cost: 0 };
    try {
        await page.evaluate(({ cardClass }) => {
            const el = document.querySelector('.' + cardClass);
            if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }, { cardClass });
    } catch (_) { /* ignore */ }
    while (Date.now() < deadline) {
        try {
            last = await page.evaluate(({ cardClass, amountTest }) => {
                const cards = document.querySelectorAll('.' + cardClass);
                let dated = 0;
                let cost = 0;
                for (const c of cards) {
                    const d = (c.querySelector('[data-test-element="service-dates-value"]')?.textContent || '')
                        .replace(/\s+/g, ' ')
                        .trim();
                    if (d.length > 2) dated += 1;
                    const a = (c.querySelector('[data-test-element="' + amountTest + '"]')?.textContent || '')
                        .replace(/\s+/g, ' ')
                        .trim();
                    if (a.length > 0) cost += 1;
                }
                return { cards: cards.length, dated, cost };
            }, { cardClass, amountTest });
        } catch (_) {
            last = { cards: 0, dated: 0, cost: 0 };
        }
        if (last.cards > 0 && (last.dated > 0 || last.cost > 0)) return last;
        await sleepMs(350);
    }
    return last;
}

/**
 * Count how many fee-schedule cards have the same **service start date** as
 * each requested ISO date. The card's end date is ignored.
 * If `requestData.checkOnlyStarts` is a non-empty array of YYYY-MM-DD strings, counts for each;
 * otherwise uses `requestData.start` only.
 * @returns {{ results: Array<{ start: string, count: number, amounts: string[] }> }}
 */
async function countExistingBillingRecordsOnPage(page, requestData) {
    const sel = uniteSelectors.billing;
    await waitForUniteFeeScheduleCardsReady(page, sel);
    const result = await page.evaluate((arg) => {
        const { data, sel } = arg;
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const parseMDY = (s) => {
            const m = norm(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
            if (!m) return null;
            const mm = +m[1], dd = +m[2], yyyy = +m[3];
            if (mm < 1 || mm > 12) return null;
            const last = new Date(yyyy, mm, 0).getDate();
            if (dd < 1 || dd > last) return null;
            const d = new Date(yyyy, mm - 1, dd);
            d.setHours(0, 0, 0, 0);
            return d;
        };
        /** Unite often shows "March 30, 2026 - April 5, 2026" (month names), not M/D/YYYY. */
        const parseMonthNameDayYear = (s) => {
            const t = norm(s);
            if (!t) return null;
            const MONTHS = {
                january: 0, jan: 0,
                february: 1, feb: 1,
                march: 2, mar: 2,
                april: 3, apr: 3,
                may: 4,
                june: 5, jun: 5,
                july: 6, jul: 6,
                august: 7, aug: 7,
                september: 8, sep: 8, sept: 8,
                october: 9, oct: 9,
                november: 10, nov: 10,
                december: 11, dec: 11
            };
            const m = t.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
            if (!m) return null;
            const mi = MONTHS[m[1].toLowerCase()];
            if (mi == null) return null;
            const dd = +m[2];
            const yyyy = +m[3];
            const last = new Date(yyyy, mi + 1, 0).getDate();
            if (dd < 1 || dd > last) return null;
            const d = new Date(yyyy, mi, dd);
            d.setHours(0, 0, 0, 0);
            return d;
        };
        const parseCardRangeStart = (s) => parseMDY(s) || parseMonthNameDayYear(s);
        const isoToDate = (iso) => {
            const m = norm(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (!m) return null;
            const d = new Date(+m[1], +m[2] - 1, +m[3]);
            d.setHours(0, 0, 0, 0);
            return d;
        };
        const sameDay = (a, b) => a && b && a.getTime() === b.getTime();

        const isoRe = /^\d{4}-\d{2}-\d{2}$/;
        let wantIsoList = [];
        if (Array.isArray(data.checkOnlyStarts) && data.checkOnlyStarts.length > 0) {
            const seen = new Set();
            for (const raw of data.checkOnlyStarts) {
                const s = norm(raw);
                if (!isoRe.test(s) || seen.has(s)) continue;
                seen.add(s);
                wantIsoList.push(s);
            }
        } else if (data.isBrooklyn && data.deliveryDate && isoRe.test(norm(data.deliveryDate))) {
            wantIsoList = [norm(data.deliveryDate)];
        } else if (data.start && isoRe.test(norm(data.start))) {
            wantIsoList = [norm(data.start)];
        }

        const scan = sel.duplicateScan || {};
        const cardClass = (scan.cardClass || 'fee-schedule-provided-service-card').replace(/^\./, '');
        const amtTest = scan.amountDataTest || 'unit-amount-value';
        const datesTests = Array.isArray(scan.datesDataTest)
            ? scan.datesDataTest
            : [scan.datesDataTest || 'service-dates-value', 'service-start-date-value'];

        const getServiceDatesTextFromCard = (card) => {
            for (const key of datesTests) {
                const el = card.querySelector('[data-test-element="' + key + '"]');
                const t = norm(el?.textContent);
                if (t) return t;
            }
            return '';
        };

        const wantDates = wantIsoList.map((iso) => isoToDate(iso)).filter(Boolean);
        const counts = {};
        const amountLists = {};
        for (const iso of wantIsoList) {
            counts[iso] = 0;
            amountLists[iso] = [];
        }

        if (wantDates.length === 0) {
            return { results: [] };
        }

        const cards = Array.from(document.querySelectorAll('.' + cardClass));

        for (const card of cards) {
            const txt = getServiceDatesTextFromCard(card);
            if (!txt) continue;

            // Examples: "3/30/2026 - 4/5/2026" or "March 30, 2026 - April 5, 2026" — only range start is used.
            const parts = txt.split(/\s*-\s*/).map((p) => norm(p)).filter(Boolean);
            const cardStart = parseCardRangeStart(parts[0] || '');
            if (!cardStart) continue;

            const amtRaw = norm(card.querySelector('[data-test-element="' + amtTest + '"]')?.textContent || '');

            for (let i = 0; i < wantDates.length; i++) {
                if (sameDay(cardStart, wantDates[i])) {
                    counts[wantIsoList[i]] += 1;
                    amountLists[wantIsoList[i]].push(amtRaw || '—');
                }
            }
        }
        return {
            results: wantIsoList.map((iso) => ({
                start: iso,
                count: counts[iso],
                amounts: amountLists[iso] || []
            }))
        };
    }, { data: requestData, sel });

    if (!result || typeof result !== 'object' || !Array.isArray(result.results)) {
        return { results: [] };
    }
    return {
        results: result.results.map((r) => ({
            start: String(r.start || ''),
            count: Number.isFinite(r.count) && r.count >= 0 ? r.count : 0,
            amounts: Array.isArray(r.amounts) ? r.amounts.map((a) => String(a ?? '')) : []
        }))
    };
}

async function executeBillingOnPage(page, requestData, execOptions = {}) {
    const submitInvoice = execOptions.submitInvoice !== false;
    console.log('[BillingActions] Injecting billing logic...');
    const sel = uniteSelectors.billing;

    try {
        await waitForUniteFeeScheduleCardsReady(page, sel);
        const result = await page.evaluate(async (arg) => {
            const { data, sel, submitInvoice } = arg;
            // =========================================================================
            //  INJECTED LOGIC START (Ported from enterBillingDetails.js)
            // =========================================================================

            console.log('[Injected] Starting billing logic for:', data);

            // --- Helpers ---
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const byXPath = (xp) => document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue || null;
            const shown = (el) => !!(el && (el.offsetParent !== null || (el.getClientRects?.().length || 0) > 0));

            // Event firers
            const fire = (el, type, init = {}) => el && el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
            const mouse = (el, type) => el && el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            const pointer = (el, type) => el && el.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true }));
            const clickLikeHuman = (el) => {
                pointer(el, 'pointerdown');
                mouse(el, 'mousedown');
                pointer(el, 'pointerup');
                mouse(el, 'mouseup');
                mouse(el, 'click');
            };
            const setNativeValue = (el, value) => {
                const desc = el?.tagName === 'TEXTAREA' ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value') : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
                if (desc?.set) desc.set.call(el, value); else if (el) el.value = value;
            };

            const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
            // Parsers
            const parseMDY = (s) => {
                const m = norm(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
                if (!m) return null;
                const mm = +m[1], dd = +m[2], yyyy = +m[3];
                if (mm < 1 || mm > 12) return null;
                const last = new Date(yyyy, mm, 0).getDate();
                if (dd < 1 || dd > last) return null;
                return new Date(yyyy, mm - 1, dd);
            };
            /** Same as check-only scan — Unite shows "March 30, 2026 - April 5, 2026", not only M/D/Y. */
            const parseMonthNameDayYear = (s) => {
                const t = norm(s);
                if (!t) return null;
                const MONTHS = {
                    january: 0, jan: 0,
                    february: 1, feb: 1,
                    march: 2, mar: 2,
                    april: 3, apr: 3,
                    may: 4,
                    june: 5, jun: 5,
                    july: 6, jul: 6,
                    august: 7, aug: 7,
                    september: 8, sep: 8, sept: 8,
                    october: 9, oct: 9,
                    november: 10, nov: 10,
                    december: 11, dec: 11
                };
                const m = t.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
                if (!m) return null;
                const mi = MONTHS[m[1].toLowerCase()];
                if (mi == null) return null;
                const dd = +m[2];
                const yyyy = +m[3];
                const last = new Date(yyyy, mi + 1, 0).getDate();
                if (dd < 1 || dd > last) return null;
                return new Date(yyyy, mi, dd);
            };
            const parseCardDate = (s) => {
                const d = parseMDY(s) || parseMonthNameDayYear(s);
                if (!d) return null;
                d.setHours(0, 0, 0, 0);
                return d;
            };
            // Format ISO YYYY-MM-DD -> MDY or Date obj -> MDY
            const toMDY = (d) => {
                if (typeof d === 'string') { // ISO string
                    const [y, m, day] = d.split('-');
                    return `${Number(m)}/${Number(day)}/${y}`;
                }
                const mm = String(d.getMonth() + 1).padStart(2, '0');
                const dd = String(d.getDate()).padStart(2, '0');
                const yy = d.getFullYear();
                return `${mm}/${dd}/${yy}`;
            };

            // --- Constants from sel (uniteSelectors.billing) ---
            const ADD_BTN_ID = sel.addButton.id;
            const ADD_BTN_XP = sel.addButton.xpath;
            const AMOUNT_ID = sel.amount.id;
            const AMOUNT_XPATH = sel.amount.xpath;
            const CANCEL_ID = sel.cancelButton.id;

            // --- Inputs ---
            // Data comes in ISO format from JSON usually: YYYY-MM-DD
            const startStr = data.start;
            const endStr = data.end;
            // Parse them to MDY for internal logic
            const [sY, sM, sD] = startStr.split('-').map(Number);
            const [eY, eM, eD] = endStr.split('-').map(Number);
            const reqStart = new Date(sY, sM - 1, sD);
            const reqEnd = new Date(eY, eM - 1, eD);
            const isBrooklyn = !!data.isBrooklyn;
            let deliveryDateObj = reqStart;
            if (isBrooklyn) {
                const dISO = data.deliveryDate || data.start;
                console.log(`[Injected][DATES] Brooklyn mode — deliveryDate=${JSON.stringify(data.deliveryDate)} start=${JSON.stringify(data.start)} using=${JSON.stringify(dISO)}`);
                if (!data.deliveryDate) {
                    console.warn('[Injected][DATES] Brooklyn: deliveryDate missing on row; falling back to start (week Monday)');
                }
                const [dy, dm, dd] = String(dISO).split('-').map(Number);
                deliveryDateObj = new Date(dy, dm - 1, dd);
            }
            let verifyStart = isBrooklyn ? deliveryDateObj : reqStart;
            let verifyEnd = isBrooklyn ? deliveryDateObj : reqEnd;
            // Amount is set in step 0 from Service Type + dependants (336 or 146 per person)
            let amount;
            let isProduce = false;

            console.log(`[Injected] Transformed dates: ${toMDY(reqStart)} -> ${toMDY(reqEnd)}`);

            const plannedDays = Math.max(1, Math.floor((reqEnd - reqStart) / 86400000) + 1);

            const doInlineScanFallback = (startD, endD, amt) => {
                const cents = (v) => {
                    const n = Number(String(v).replace(/[^\d.]/g, ''));
                    return Number.isFinite(n) ? Math.round(n * 100) : NaN;
                };
                const sameDay = (a, b) => a && b && a.getTime() === b.getTime();
                const scan = sel.duplicateScan || {};
                const cardClass = (scan.cardClass || 'fee-schedule-provided-service-card').replace(/^\./, '');
                const cards = Array.from(document.querySelectorAll('.' + cardClass));
                const tCents = cents(amt);
                const amtTest = scan.amountDataTest || 'unit-amount-value';
                const datesTests = Array.isArray(scan.datesDataTest)
                    ? scan.datesDataTest
                    : [scan.datesDataTest || 'service-dates-value', 'service-start-date-value'];
                const getServiceDatesTextFromCard = (card) => {
                    for (const key of datesTests) {
                        const el = card.querySelector('[data-test-element="' + key + '"]');
                        const t = norm(el?.textContent);
                        if (t) return t;
                    }
                    return '';
                };
                for (const card of cards) {
                    const amtEl = card.querySelector('[data-test-element="' + amtTest + '"]');
                    const amtCents = cents(norm(amtEl?.textContent));
                    const txt = getServiceDatesTextFromCard(card);
                    if (!txt) continue;
                    const parts = txt.split(/\s*-\s*/).map((p) => norm(p)).filter(Boolean);
                    let s = null;
                    let e = null;
                    if (parts.length >= 2) {
                        s = parseCardDate(parts[0]);
                        e = parseCardDate(parts[1]);
                    } else if (parts.length === 1) {
                        s = parseCardDate(parts[0]);
                        e = s;
                    }
                    if (!s || !e) continue;
                    if (Number.isFinite(amtCents) && amtCents === tCents && sameDay(s, startD) && sameDay(e, endD)) {
                        return true;
                    }
                }
                return false;
            };

            let currentStep = 'init';
            function classifyError(msg) {
                if (!msg) return 'UNKNOWN';
                const m = String(msg);
                if (/null|querySelector|reading\s+'|offsetParent|\.value|\.click/.test(m)) return 'ELEMENT_NOT_FOUND';
                if (/timeout|Timeout/.test(m)) return 'TIMEOUT';
                if (/closed|has been closed/.test(m)) return 'BROWSER_CLOSED';
                if (/Fetch failed|network|ECONNREFUSED/.test(m)) return 'NETWORK';
                return 'RUNTIME_ERROR';
            }

            try {
            // --- 0. Wait for Authorized Table (Page Ready Check) ---
            currentStep = 'wait_authorized_table';
            const AUTH_DATE_ID = sel.authorizedTable.date.id;
            const AUTH_AMOUNT_ID = sel.authorizedTable.amount.id;
            const stSel = sel.authorizedTable.serviceType || {};
            const SERVICE_TYPE_ID = stSel.id || 'basic-table-service-type-value';
            const SERVICE_TYPE_XP = stSel.xpath;
            console.log('[Injected] Waiting for Authorized Table elements...');
            const AUTH_OPENED_ID = sel.authorizedTable.dateOpened.id;
            const AUTH_OPENED_XP = sel.authorizedTable.dateOpened.xpath;
            const getAuthEls = () => ({
                dateEl: document.getElementById(AUTH_DATE_ID) || byXPath(sel.authorizedTable.date.xpath),
                amountEl: document.getElementById(AUTH_AMOUNT_ID) || byXPath(sel.authorizedTable.amount.xpath),
                dateOpenedEl: document.getElementById(AUTH_OPENED_ID) || (AUTH_OPENED_XP ? byXPath(AUTH_OPENED_XP) : null),
                serviceTypeEl: document.getElementById(SERVICE_TYPE_ID) || (SERVICE_TYPE_XP ? byXPath(SERVICE_TYPE_XP) : null)
            });

            for (let i = 0; i < 30; i++) {
                const { dateEl, amountEl } = getAuthEls();
                if (dateEl && amountEl && shown(dateEl)) break;
                await sleep(500);
            }

            const { dateEl, amountEl, dateOpenedEl, serviceTypeEl } = getAuthEls();

            // --- Service Type: set amount per person (336 or 146 if Produce) ---
            const numDependants = (data.dependants && Array.isArray(data.dependants)) ? data.dependants.length : 0;
            const people = 1 + numDependants;
            if (serviceTypeEl) {
                const serviceTypeText = (serviceTypeEl.textContent || serviceTypeEl.innerText || '').trim();
                isProduce = serviceTypeText.toLowerCase().includes('produce');
                amount = isProduce ? 146 * people : 336 * people;
                console.log(`[Injected] Service Type: "${serviceTypeText}" → ${isProduce ? 'Produce' : 'MTM'}, ${people} person(s), amount: $${amount}`);
            } else {
                amount = (typeof data.amount === 'number' && data.amount > 0) ? data.amount : 336 * people;
                console.warn('[Injected] Service Type element not found; using amount from API or default $336/person:', amount);
            }

            if (!dateEl || !amountEl) {
                console.warn('[Injected] Authorized table elements not found. Continuing, but risks are high.');
            } else {
                console.log('[Injected] Authorized table found. Verifying limits...');
                // Authorized delivery range (end only used for clamping; start bound is Date Opened — same as billingWorker)
                // Date format usually: "8/27/2025 - 2/27/2026"
                const dateText = dateEl.innerText || '';
                const rangeParts = dateText.split(/\s*-\s*/).map((s) => s.trim());
                const endStr = rangeParts[1] || '';
                const authEnd = endStr ? parseMDY(endStr) : null;

                const normTxt = (s) => String(s || '').trim();
                const dateOpenedP = dateOpenedEl?.querySelector('p.service-case-program-entry__text');
                const dateOpenedRaw = normTxt(dateOpenedP ? dateOpenedP.textContent : dateOpenedEl?.textContent);
                let dateOpenedBound = parseMDY(dateOpenedRaw);
                if (!dateOpenedBound && dateOpenedRaw) {
                    const m = dateOpenedRaw.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
                    if (m) dateOpenedBound = parseMDY(`${m[1]}/${m[2]}/${m[3]}`);
                }

                // Amount format usually: $7,824.00 inside a span
                const amountText = (amountEl.innerText || '').replace(/[$,]/g, '');
                const authAmount = parseFloat(amountText);

                console.log('[Injected] Authorized Amount:', (amountEl.innerText || '').trim());
                console.log('[Injected] Date Opened:', dateOpenedRaw || 'N/A');
                console.log('[Injected] Authorized range text:', dateText.trim() || 'N/A');
                console.log('[Injected] Auth end (clamp):', endStr || 'N/A', '| Max: $' + authAmount);

                // --- CLAMPING LOGIC (synced with billingWorker: start = Date Opened, end = auth range end) ---
                if (isBrooklyn) {
                    console.log(`[Clamping-Debug] Brooklyn delivery date: ${toMDY(deliveryDateObj)}`);
                    console.log(`[Clamping-Debug] Clamp window: Date Opened ${dateOpenedBound ? toMDY(dateOpenedBound) : 'N/A'} .. Auth End ${authEnd ? toMDY(authEnd) : 'N/A'}`);
                    if (dateOpenedBound && deliveryDateObj < dateOpenedBound) {
                        console.warn(`[Clamping] Delivery ${toMDY(deliveryDateObj)} is BEFORE Date Opened ${toMDY(dateOpenedBound)}. Adjusting...`);
                        deliveryDateObj.setTime(dateOpenedBound.getTime());
                    }
                    if (authEnd && deliveryDateObj > authEnd) {
                        console.warn(`[Clamping] Delivery ${toMDY(deliveryDateObj)} is AFTER Auth End ${toMDY(authEnd)}. Adjusting...`);
                        deliveryDateObj.setTime(authEnd.getTime());
                    }
                    if ((dateOpenedBound && deliveryDateObj < dateOpenedBound) || (authEnd && deliveryDateObj > authEnd)) {
                        const authRangeEndDisp = endStr || 'N/A';
                        return {
                            ok: false,
                            error: `[LIMITS] Delivery date ${toMDY(deliveryDateObj)} is outside Date Opened / Auth End (${dateOpenedRaw || 'N/A'} to ${authRangeEndDisp})`
                        };
                    }
                    verifyStart = deliveryDateObj;
                    verifyEnd = deliveryDateObj;
                } else if (dateOpenedBound || authEnd) {
                    // CLAMPING DEBUG LOGS
                    console.log(`[Clamping-Debug] Original Req Start: ${toMDY(reqStart)} (${reqStart.toISOString()})`);
                    console.log(`[Clamping-Debug] Original Req End:   ${toMDY(reqEnd)} (${reqEnd.toISOString()})`);
                    console.log(`[Clamping-Debug] Clamp window:        Date Opened ${dateOpenedBound ? toMDY(dateOpenedBound) : 'N/A'} .. Auth End ${authEnd ? toMDY(authEnd) : 'N/A'}`);

                    if (dateOpenedBound && reqStart < dateOpenedBound) {
                        console.warn(`[Clamping] Requested start ${toMDY(reqStart)} is BEFORE Date Opened ${toMDY(dateOpenedBound)}. Adjusting...`);
                        reqStart.setTime(dateOpenedBound.getTime());
                    }
                    if (authEnd && reqEnd > authEnd) {
                        console.warn(`[Clamping] Requested end ${toMDY(reqEnd)} is AFTER auth end ${toMDY(authEnd)}. Adjusting to ${toMDY(authEnd)}.`);
                        reqEnd.setTime(authEnd.getTime());
                    }

                    console.log(`[Clamping-Debug] Final Req Start:    ${toMDY(reqStart)}`);
                    console.log(`[Clamping-Debug] Final Req End:      ${toMDY(reqEnd)}`);

                    // Fix overlap
                    if (reqStart > reqEnd) {
                        const authRangeEndDisp = endStr || 'N/A';
                        return {
                            ok: false,
                            error: `[LIMITS] No overlap: requested (${toMDY(data.start)} to ${toMDY(data.end)}) is outside Date Opened / Auth End (${dateOpenedRaw || 'N/A'} to ${authRangeEndDisp})`
                        };
                    }

                    // For regular (MTM) clients only: when dates were clamped in worker, use 48 × days × people
                    if (!isProduce && data.datesWereClamped && typeof data.amount === 'number' && data.amount > 0) {
                        amount = data.amount * people;
                        console.log(`[Injected] Dates were clamped; using 48/day × ${people} person(s) for MTM: $${amount}`);
                    }
                }

                // Amount vs max auth (runs whenever we parsed a numeric auth max)
                if (Number.isFinite(authAmount) && amount > authAmount) {
                    console.warn(`[Clamping] WARNING: Requested amount $${amount} > Auth Max $${authAmount}. Proceeding as requested, but might fail.`);
                }
            }

            // --- Early duplicate guard (after amount is set from Service Type) ---
            if (doInlineScanFallback(verifyStart, verifyEnd, amount)) {
                console.warn('[Injected] Duplicate detected (early). Aborting.');
                return { ok: false, duplicate: true, error: '[DUPLICATE] Duplicate invoice detected' };
            }

            // --- 1. Find Add Button & Open Shelf ---
            currentStep = 'open_shelf';
            const addBtnText = (sel.addButton.textContains || 'add new contracted service').toLowerCase();
            const findAddButton = () => {
                let btn = document.getElementById(ADD_BTN_ID) || byXPath(ADD_BTN_XP);
                if (btn) return btn;
                const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
                return buttons.find(b => (b.textContent || '').toLowerCase().includes(addBtnText)) || null;
            };

            let addBtn = null;
            for (let i = 0; i < 10; i++) {
                addBtn = findAddButton();
                if (addBtn && shown(addBtn)) break;
                await sleep(500);
            }

            if (!addBtn) return { ok: false, error: '[SHELF] Could not find "Add New Contracted Service" button (Shelf trigger missing)' };

            // Open Check
            const isShelfOpen = () => !!(document.getElementById(AMOUNT_ID) || byXPath(AMOUNT_XPATH));

            if (!isShelfOpen()) {
                console.log('[Injected] Clicking Add Button...');
                clickLikeHuman(addBtn);
                // Wait for shelf
                for (let i = 0; i < 20; i++) {
                    if (isShelfOpen()) break;
                    await sleep(200);
                }
                if (!isShelfOpen()) return { ok: false, error: '[SHELF] Billing shelf failed to open after clicking "Add"' };
            }

            // --- 2. Calculate & Verify Dates ---
            const days = Math.floor((reqEnd - reqStart) / 86400000) + 1;
            // const amount = days * ratePerDay; // DEPRECATED - used from JSON
            console.log(`[Step] Date Calculation: ${startStr} to ${endStr} = ${days} days.`);
            console.log(`[Step] Amount (Explicit): $${amount}`);

            if (days < 1) {
                return { ok: false, error: `[DATES] Invalid date range: ${days} days` };
            }

            // --- 3. Fill Billing Info ---
            currentStep = 'fill_amount';
            // Fill Amount
            const amountField = document.getElementById(AMOUNT_ID) || byXPath(AMOUNT_XPATH);
            if (!amountField) return { ok: false, error: '[SHELF] Failed to find "Unit Amount" input field on billing shelf' };

            console.log(`[Step] Entering Amount: ${amount}...`);
            if (amount === undefined || amount === null) {
                return { ok: false, error: '[DATES] Calculated amount is null/undefined before entry' };
            }
            amountField.focus();
            setNativeValue(amountField, String(amount));
            fire(amountField, 'input');
            fire(amountField, 'change');
            amountField.blur();
            await sleep(500);

            // --- 4. Period of Service: Brooklyn = Single Date; main = Date Range ---
            currentStep = isBrooklyn ? 'set_single_date' : 'set_date_range';

            if (isBrooklyn) {
                console.log('[DateLogic] Brooklyn: selecting Single Date and setting delivery date...');
                const period = sel.periodOfService || {};
                const singleDateRadioId = period.singleDateRadioId || 'provided-service-period-of-service-0';
                const singleDateRadio =
                    document.getElementById(singleDateRadioId) ||
                    document.querySelector('input[name="provided_service.period_of_service"][value="Single Date"]') ||
                    Array.from(document.querySelectorAll('input[name="provided_service.period_of_service"]')).find(
                        (r) => (r.nextElementSibling?.textContent || r.labels?.[0]?.textContent || '').trim().toLowerCase().includes('single')
                    );
                if (singleDateRadio && !singleDateRadio.checked) {
                    clickLikeHuman(singleDateRadio);
                    await sleep(400);
                    const labelForRadio = document.querySelector(`label[for="${singleDateRadio.id}"]`);
                    if (labelForRadio && !singleDateRadio.checked) clickLikeHuman(labelForRadio);
                    await sleep(300);
                } else if (!singleDateRadio) {
                    console.warn('[DateLogic] Single Date radio not found; continuing with service date input.');
                }

                const sd = sel.singleDate || {};
                const inputId = sd.inputId || 'provided-service-date';
                const serviceInput = document.getElementById(inputId);
                if (!serviceInput) {
                    return { ok: false, error: '[DATES] Brooklyn Single Date input #' + inputId + ' not found' };
                }

                const pressKey = (el, key, code, keyCode) => {
                    const opts = { key, code, keyCode, which: keyCode, view: window, bubbles: true, cancelable: true };
                    el.dispatchEvent(new KeyboardEvent('keydown', opts));
                    el.dispatchEvent(new KeyboardEvent('keypress', { ...opts, charCode: keyCode }));
                    el.dispatchEvent(new KeyboardEvent('keyup', opts));
                };

                const mdy = toMDY(deliveryDateObj);
                console.log('[DateLogic] Brooklyn: setting service date (delivery):', mdy);
                serviceInput.focus();
                await sleep(100);
                setNativeValue(serviceInput, mdy);
                fire(serviceInput, 'input');
                fire(serviceInput, 'change');
                await sleep(100);
                pressKey(serviceInput, 'Tab', 'Tab', 9);
                await sleep(150);
                serviceInput.blur();
                await sleep(200);

                if (serviceInput.value !== mdy) {
                    return { ok: false, error: `[DATES] Brooklyn service date mismatch: got "${serviceInput.value}", expected "${mdy}"` };
                }
                verifyStart = deliveryDateObj;
                verifyEnd = deliveryDateObj;
                console.log('[Step] Brooklyn single date UI interaction complete.');
            } else {
            // --- Date Range path (main account) ---
            const period = sel.periodOfService || {};
            const dateRangeRadioId = period.dateRangeRadioId || 'provided-service-period-of-service-1';
            const dateRangeRadio = document.getElementById(dateRangeRadioId) ||
                document.querySelector(`input[name="provided_service.period_of_service"][value="Date Range"]`) ||
                (() => {
                    const label = document.getElementById(period.dateRangeLabelId || 'Date Range-label') ||
                        Array.from(document.querySelectorAll('label')).find(l => (l.textContent || '').trim() === 'Date Range');
                    return label ? document.getElementById(label.getAttribute('for')) : null;
                })();
            if (dateRangeRadio && !dateRangeRadio.checked) {
                console.log('[DateLogic] Selecting "Date Range" radio...');
                clickLikeHuman(dateRangeRadio);
                await sleep(400);
                const labelForRadio = document.querySelector(`label[for="${dateRangeRadioId}"]`);
                if (labelForRadio && !dateRangeRadio.checked) clickLikeHuman(labelForRadio);
                await sleep(300);
            } else if (!dateRangeRadio) {
                console.warn('[DateLogic] Period of Service "Date Range" radio not found; continuing (form may not have Single vs Range).');
            }

            console.log('[Step] Setting Date Range in UI...');

            // ===== Robust Date Picker Logic (Ported from Extension) =====
            async function setDateRangeRobust(bStart, bEnd) {
                console.log(`[DateLogic] Setting range: ${toMDY(bStart)} -> ${toMDY(bEnd)}`);
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));

                const M = (el, t) => el && el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
                const P = (el, t) => el && el.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
                const clickLikeHuman = (el) => { P(el, 'pointerdown'); M(el, 'mousedown'); P(el, 'pointerup'); M(el, 'mouseup'); M(el, 'click'); };
                const getCoords = (el) => {
                    const r = el.getBoundingClientRect();
                    const x = r.left + r.width / 2, y = r.top + r.height / 2;
                    return { clientX: x, clientY: y, pageX: x + window.pageXOffset, pageY: y + window.pageYOffset };
                };
                const clickHumanAsync = async (el, delayMs = 20) => {
                    if (!el) return;
                    el.scrollIntoView?.({ block: 'center', inline: 'center' });
                    await sleep(50);
                    const c = getCoords(el);
                    el.focus?.();
                    await sleep(30);
                    const m = (t, o) => el.dispatchEvent(new MouseEvent(t, { view: window, bubbles: true, cancelable: true, ...c, ...o }));
                    const p = (t, o) => el.dispatchEvent(new PointerEvent(t, { pointerId: 1, pointerType: 'mouse', isPrimary: true, pressure: t === 'pointerdown' ? 1 : 0, width: 1, height: 1, ...c, bubbles: true, cancelable: true, ...o }));
                    m('mousemove', {}); p('pointermove', {});
                    await sleep(delayMs);
                    p('pointerdown', { buttons: 1 });
                    await sleep(delayMs);
                    m('mousedown', { buttons: 1, detail: 1 });
                    await sleep(delayMs);
                    p('pointerup', { buttons: 0 });
                    await sleep(delayMs);
                    m('mouseup', { buttons: 0, detail: 1 });
                    await sleep(delayMs);
                    m('click', { detail: 1 });
                };

                const dr = sel.dateRange;
                const RANGE_BTN_ID = dr.buttonId;
                const START_YR_ID = dr.startYearId;
                const END_YR_ID = dr.endYearId;
                const DATE_RANGE_LABEL_ID = dr.labelId;
                const isOpen = () => {
                    const openEl = dr.dropdownOpenClass && document.querySelector('.' + dr.dropdownOpenClass.replace(/\s+/g, '.'));
                    if (openEl) return true;
                    const dd = document.querySelector(dr.dropdownClass);
                    if (dd && (dd.offsetParent !== null || (dd.getBoundingClientRect?.().height || 0) > 0)) return true;
                    const durationDdEl = dr.durationDropdown && document.querySelector(dr.durationDropdown);
                    if (durationDdEl && (durationDdEl.offsetParent !== null || (durationDdEl.getBoundingClientRect?.().height || 0) > 0)) return true;
                    return false;
                };

                // 1. OPEN PICKER (Robust Logic Exact Match)
                const getFakeCandidates = () => {
                    const fi = dr.fakeInput;
                    const byTrigger = dr.triggerXpath ? byXPath(dr.triggerXpath) : null;
                    const a = document.getElementById(RANGE_BTN_ID);
                    const b = document.querySelector(fi.roleButton);
                    const c = document.querySelector(fi.value);
                    const d = document.querySelector(fi.container);
                    return [byTrigger, a, b, c, d].filter(Boolean);
                };

                const openPicker = async () => {
                    if (isOpen()) return true;

                    const labelID = dr.labelId;
                    const labelXP = dr.labelXpath;
                    const label = document.getElementById(labelID) || byXPath(labelXP);
                    const triggerBtn = dr.triggerXpath ? byXPath(dr.triggerXpath) : null;

                    const tryOnce = async () => {
                        const cands = getFakeCandidates();
                        console.log('[DateLogic] Attempting to open picker...');

                        // 0) Calendar open button (trigger XPath) – when Date Range is selected this is the button
                        if (triggerBtn && shown(triggerBtn)) {
                            console.log('[DateLogic] Clicking calendar trigger (triggerXpath)...');
                            await clickHumanAsync(triggerBtn, 25);
                            for (let i = 0; i < 15; i++) { if (isOpen()) return true; await sleep(80); }
                        }

                        // 1) Label tap (some builds need it to reveal inputs)
                        if (label && shown(label)) {
                            console.log('[DateLogic] Clicking label specificially...');
                            clickLikeHuman(label);
                            await sleep(120);
                            if (isOpen()) return true;
                        }

                        // 2) Try all fake candidates
                        for (const el of cands) {
                            if (!shown(el)) continue;
                            console.log('[DateLogic] Clicking candidate:', el.tagName, el.className);
                            el.scrollIntoView?.({ block: 'center', inline: 'center' });
                            await sleep(40);
                            clickLikeHuman(el);
                            for (let i = 0; i < 10; i++) { if (isOpen()) return true; await sleep(60); }
                        }

                        // 3) Keyboard fallback on best candidate
                        const best = cands.find(shown);
                        if (best) {
                            console.log('[DateLogic] Trying keyboard fallback...');
                            best.focus?.();
                            best.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
                            best.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
                            await sleep(120);
                            if (isOpen()) return true;
                            best.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
                            best.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
                            for (let i = 0; i < 10; i++) { if (isOpen()) return true; await sleep(60); }
                        }
                        return false;
                    };

                    for (let attempt = 1; attempt <= 3 && !isOpen(); attempt++) {
                        if (await tryOnce()) break;
                        await sleep(150 + attempt * 100);
                    }
                    return isOpen();
                };

                if (!await openPicker()) {
                    return { ok: false, error: '[DATES] Could not open Date Range picker after multiple attempts' };
                }
                console.log('[DateLogic] Picker is open.');
                await sleep(400);

                // --- Two-calendar flow: try duration-field first, then date-field (DOM may use ui-date-field) ---
                const durationDd = dr.durationDropdown && document.querySelector(dr.durationDropdown);
                let calendarFlowDone = false;
                if (durationDd) {
                    const leftCal = dr.durationCalLeft && durationDd.querySelector(dr.durationCalLeft);
                    const rightCal = dr.durationCalRight && durationDd.querySelector(dr.durationCalRight);
                    if (leftCal && rightCal) {
                        console.log('[DateLogic] Using duration-field calendar path (two panes).');
                        const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
                        const monthNameToIdx = (name) => MONTH_NAMES.indexOf(String(name || '').trim().toLowerCase());
                        const getVis = (ddEl) => {
                            const spans = ddEl.querySelectorAll('.ui-duration-field__controls div span');
                            const sy = ddEl.querySelector('#' + (dr.durationStartYearId || 'provided-service-dates-start-year'));
                            const ey = ddEl.querySelector('#' + (dr.durationEndYearId || 'provided-service-dates-end-year'));
                            const lM = spans[0] ? monthNameToIdx(spans[0].textContent) : -1;
                            const rM = spans[1] ? monthNameToIdx(spans[1].textContent) : -1;
                            const lY = parseInt(sy?.value || '0', 10);
                            const rY = parseInt(ey?.value || '0', 10);
                            return [{ monthIdx: lM, year: lY }, { monthIdx: rM, year: rY }];
                        };
                        const ensureMonth = async (targetMonthIdx, targetYear) => {
                            const prev = durationDd.querySelector(dr.durationPrev);
                            const next = durationDd.querySelector(dr.durationNext);
                            if (!prev || !next) return false;
                            const targetAbs = targetYear * 12 + targetMonthIdx;
                            for (let i = 0; i < 36; i++) {
                                const vis = getVis(durationDd);
                                if (!vis) return false;
                                const leftAbs = vis[0].year * 12 + vis[0].monthIdx;
                                const rightAbs = vis[1].year * 12 + vis[1].monthIdx;
                                if (targetAbs >= leftAbs && targetAbs <= rightAbs) return true;
                                if (targetAbs < leftAbs) await clickHumanAsync(prev, 25);
                                else await clickHumanAsync(next, 25);
                                await sleep(300);
                            }
                            return false;
                        };
                        const clickDayInPane = async (pane, dayNum) => {
                            const want = String(dayNum);
                            const cells = pane.querySelectorAll(dr.durationDayButton || '.ui-calendar__day:not(.ui-calendar__day--out-of-month) div[role="button"]');
                            const btn = Array.from(cells).find(b => (b.textContent || '').trim() === want);
                            if (!btn) return false;
                            await clickHumanAsync(btn, 25);
                            await sleep(200);
                            return true;
                        };
                        const pickPane = (vis, targetAbs) => {
                            const leftAbs = vis[0].year * 12 + vis[0].monthIdx;
                            const rightAbs = vis[1].year * 12 + vis[1].monthIdx;
                            return targetAbs === leftAbs ? leftCal : targetAbs === rightAbs ? rightCal : leftCal;
                        };
                        if (await ensureMonth(bStart.getMonth(), bStart.getFullYear())) {
                            const vis = getVis(durationDd);
                            const pane = pickPane(vis, bStart.getFullYear() * 12 + bStart.getMonth());
                            const startOk = await clickDayInPane(pane, bStart.getDate());
                            if (startOk && await ensureMonth(bEnd.getMonth(), bEnd.getFullYear())) {
                                const vis2 = getVis(durationDd);
                                const pane2 = pickPane(vis2, bEnd.getFullYear() * 12 + bEnd.getMonth());
                                const endOk = await clickDayInPane(pane2, bEnd.getDate());
                                if (endOk) {
                                    for (let i = 0; i < 25; i++) {
                                        const stillOpen = durationDd.offsetParent !== null || (durationDd.getBoundingClientRect?.().height || 0) > 0;
                                        if (!stillOpen) break;
                                        await sleep(80);
                                    }
                                    const triggerBtn = dr.triggerXpath ? byXPath(dr.triggerXpath) : null;
                                    if (triggerBtn && shown(triggerBtn)) { await clickHumanAsync(triggerBtn, 25); await sleep(200); }
                                    await sleep(300);
                                    console.log('[DateLogic] Calendar-click flow done (duration-field).');
                                    calendarFlowDone = true;
                                    return true;
                                }
                            }
                        }
                    } else {
                        console.log('[DateLogic] Duration dropdown found but two calendars not found; trying date-field path.');
                    }
                } else {
                    console.log('[DateLogic] Duration dropdown not found (selector: ' + (dr.durationDropdown || '') + '); trying date-field two-calendar path.');
                }

                // Date-field two-calendar path (when DOM uses ui-date-field instead of ui-duration-field)
                if (!calendarFlowDone && dr.dropdownClass) {
                    const dateFieldDd = document.querySelector(dr.dropdownClass);
                    if (dateFieldDd) {
                        const calSelector = dr.dateFieldCalendars || '.ui-calendar';
                        const calendars = dateFieldDd.querySelectorAll(calSelector);
                        const leftCalDf = calendars.length >= 2 ? calendars[0] : null;
                        const rightCalDf = calendars.length >= 2 ? calendars[1] : null;
                        if (leftCalDf && rightCalDf) {
                            console.log('[DateLogic] Using date-field two-calendar path.');
                            const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
                            const monthNameToIdx = (name) => MONTH_NAMES.indexOf(String(name || '').trim().toLowerCase());
                            const controlsSel = dr.dateFieldControls || '.ui-date-field__controls';
                            const spansSel = controlsSel + ' div span';
                            const yearStartId = dr.durationStartYearId || 'provided-service-dates-start-year';
                            const yearEndId = dr.durationEndYearId || 'provided-service-dates-end-year';
                            const getVisDf = (ddEl) => {
                                const spans = ddEl.querySelectorAll(spansSel);
                                const sy = document.getElementById(yearStartId) || ddEl.querySelector('#' + yearStartId);
                                const ey = document.getElementById(yearEndId) || ddEl.querySelector('#' + yearEndId);
                                const lM = spans[0] ? monthNameToIdx(spans[0].textContent) : -1;
                                const rM = spans[1] ? monthNameToIdx(spans[1].textContent) : -1;
                                const lY = parseInt(sy?.value || '0', 10);
                                const rY = parseInt(ey?.value || '0', 10);
                                return [{ monthIdx: lM, year: lY }, { monthIdx: rM, year: rY }];
                            };
                            const prevDf = dateFieldDd.querySelector(dr.navPrev);
                            const nextDf = dateFieldDd.querySelector(dr.navNext);
                            const ensureMonthDf = async (targetMonthIdx, targetYear) => {
                                if (!prevDf || !nextDf) return false;
                                const targetAbs = targetYear * 12 + targetMonthIdx;
                                for (let i = 0; i < 36; i++) {
                                    const vis = getVisDf(dateFieldDd);
                                    if (!vis || vis[0].monthIdx < 0) return false;
                                    const leftAbs = vis[0].year * 12 + vis[0].monthIdx;
                                    const rightAbs = vis[1].year * 12 + vis[1].monthIdx;
                                    if (targetAbs >= leftAbs && targetAbs <= rightAbs) return true;
                                    if (targetAbs < leftAbs) await clickHumanAsync(prevDf, 25);
                                    else await clickHumanAsync(nextDf, 25);
                                    await sleep(300);
                                }
                                return false;
                            };
                            const dayBtnSel = dr.durationDayButton || '.ui-calendar__day:not(.ui-calendar__day--out-of-month) div[role="button"]';
                            const clickDayInPaneDf = async (pane, dayNum) => {
                                const want = String(dayNum);
                                const cells = pane.querySelectorAll(dayBtnSel);
                                const btn = Array.from(cells).find(b => (b.textContent || '').trim() === want);
                                if (!btn) return false;
                                await clickHumanAsync(btn, 25);
                                await sleep(200);
                                return true;
                            };
                            const pickPaneDf = (vis, targetAbs) => {
                                const leftAbs = vis[0].year * 12 + vis[0].monthIdx;
                                const rightAbs = vis[1].year * 12 + vis[1].monthIdx;
                                return targetAbs === leftAbs ? leftCalDf : targetAbs === rightAbs ? rightCalDf : leftCalDf;
                            };
                            if (await ensureMonthDf(bStart.getMonth(), bStart.getFullYear())) {
                                const vis = getVisDf(dateFieldDd);
                                const pane = pickPaneDf(vis, bStart.getFullYear() * 12 + bStart.getMonth());
                                const startOk = await clickDayInPaneDf(pane, bStart.getDate());
                                if (startOk && await ensureMonthDf(bEnd.getMonth(), bEnd.getFullYear())) {
                                    const vis2 = getVisDf(dateFieldDd);
                                    const pane2 = pickPaneDf(vis2, bEnd.getFullYear() * 12 + bEnd.getMonth());
                                    const endOk = await clickDayInPaneDf(pane2, bEnd.getDate());
                                    if (endOk) {
                                        for (let i = 0; i < 25; i++) {
                                            const stillOpen = dateFieldDd.offsetParent !== null || (dateFieldDd.getBoundingClientRect?.().height || 0) > 0;
                                            if (!stillOpen) break;
                                            await sleep(80);
                                        }
                                        const triggerBtn = dr.triggerXpath ? byXPath(dr.triggerXpath) : null;
                                        if (triggerBtn && shown(triggerBtn)) { await clickHumanAsync(triggerBtn, 25); await sleep(200); }
                                        await sleep(300);
                                        console.log('[DateLogic] Calendar-click flow done (date-field).');
                                        return true;
                                    }
                                }
                            }
                        }
                    }
                }

                // Rewritten UI: start/end text inputs, mouse clicks in both (end then start), then close (wait / click outside / Tab / Enter)
                const startInput = (dr.startInputId && document.getElementById(dr.startInputId)) || (dr.startInputXpath && byXPath(dr.startInputXpath));
                const endInput = (dr.endInputId && document.getElementById(dr.endInputId)) || (dr.endInputXpath && byXPath(dr.endInputXpath));
                if (startInput && endInput) {
                    console.log('[DateLogic] Using start/end text inputs (calendar paths did not run or did not complete).');
                    const pressKey = (el, key, code, keyCode) => {
                        const opts = { key, code, keyCode, which: keyCode, view: window, bubbles: true, cancelable: true };
                        el.dispatchEvent(new KeyboardEvent('keydown', opts));
                        el.dispatchEvent(new KeyboardEvent('keypress', { ...opts, charCode: keyCode }));
                        el.dispatchEvent(new KeyboardEvent('keyup', opts));
                    };
                    startInput.focus();
                    await sleep(100);
                    setNativeValue(startInput, toMDY(bStart));
                    fire(startInput, 'input');
                    fire(startInput, 'change');
                    await sleep(100);
                    pressKey(startInput, 'Tab', 'Tab', 9);
                    await sleep(200);
                    endInput.focus();
                    await sleep(100);
                    setNativeValue(endInput, toMDY(bEnd));
                    fire(endInput, 'input');
                    fire(endInput, 'change');
                    await sleep(100);
                    pressKey(endInput, 'Tab', 'Tab', 9);
                    await sleep(200);
                    const triggerBtn = dr.triggerXpath ? byXPath(dr.triggerXpath) : null;
                    const isOpenNow = () => {
                        const openEl = dr.dropdownOpenClass && document.querySelector('.' + dr.dropdownOpenClass.replace(/\s+/g, '.'));
                        if (openEl) return true;
                        const dd = document.querySelector(dr.dropdownClass);
                        if (dd && (dd.offsetParent !== null || (dd.getBoundingClientRect?.().height || 0) > 0)) return true;
                        return !!(startInput.offsetParent !== null || (startInput.getBoundingClientRect?.().height || 0) > 0);
                    };
                    if (endInput && shown(endInput)) {
                        await clickHumanAsync(endInput, 25);
                        await sleep(150);
                    }
                    if (startInput && shown(startInput)) {
                        await clickHumanAsync(startInput, 25);
                        await sleep(150);
                    }
                    for (let i = 0; i < 25; i++) {
                        if (!isOpenNow()) break;
                        await sleep(80);
                    }
                    if (!isOpenNow()) { await sleep(200); return true; }
                    endInput.blur();
                    await sleep(100);
                    if (triggerBtn && shown(triggerBtn)) {
                        await clickHumanAsync(triggerBtn, 25);
                        await sleep(200);
                    }
                    if (!isOpenNow()) { await sleep(200); return true; }
                    endInput.focus();
                    await sleep(80);
                    pressKey(endInput, 'Tab', 'Tab', 9);
                    await sleep(200);
                    if (!isOpenNow()) { await sleep(200); return true; }
                    if (startInput) startInput.focus();
                    await sleep(80);
                    endInput.focus();
                    await sleep(120);
                    pressKey(endInput, 'Enter', 'Enter', 13);
                    await sleep(150);
                    pressKey(endInput, 'Enter', 'Enter', 13);
                    await sleep(300);
                    return true;
                }

                const dd = document.querySelector(dr.dropdownClass);
                if (!dd) {
                    return { ok: false, error: '[DATES] Date picker dropdown container not found (selector: ' + (dr.dropdownClass || '') + '). DOM may have changed.' };
                }
                const prevBtn = dd.querySelector(dr.navPrev);
                const nextBtn = dd.querySelector(dr.navNext);
                const startYearInput = dd.querySelector('#' + START_YR_ID);
                const endYearInput = dd.querySelector('#' + END_YR_ID);
                const leftCal = dd.querySelector(dr.leftCalendar);
                const rightCal = dd.querySelector(dr.rightCalendar);
                const leftSpan = dd.querySelector(dr.leftSpan);
                const rightSpan = dd.querySelector(dr.rightSpan);

                if (!prevBtn || !nextBtn) {
                    return { ok: false, error: '[DATES] Date picker calendar controls (prev/next buttons) are missing or hidden' };
                }

                const monthIdx = (name) => ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
                    .indexOf(String(name || '').trim().toLowerCase());

                const getVisibleRange = () => {
                    const lMonth = monthIdx(leftSpan.textContent);
                    const rMonth = monthIdx(rightSpan.textContent);
                    const lYear = parseInt(startYearInput?.value || '0', 10);
                    const rYear = parseInt(endYearInput?.value || '0', 10);
                    return { left: lYear * 12 + lMonth, right: rYear * 12 + rMonth, lYear, rYear, lMonth, rMonth };
                };

                const ensureVis = async (date) => {
                    const target = date.getFullYear() * 12 + date.getMonth();
                    for (let i = 0; i < 24; i++) {
                        const { left, right } = getVisibleRange();
                        if (target >= left && target <= right) return true;
                        if (target < left) clickLikeHuman(prevBtn);
                        else clickLikeHuman(nextBtn);
                        await sleep(300); // Wait for transition
                    }
                    return false;
                };

                const clickDay = async (pane, date) => {
                    const want = String(date.getDate());
                    const btns = Array.from(pane.querySelectorAll(dr.dayButton));
                    const btn = btns.find(b => (b.textContent || '').trim() === want);
                    if (!btn) return false;
                    btn.scrollIntoView?.({ block: 'center', inline: 'center' });
                    await sleep(80);
                    P(btn, 'pointerdown');
                    M(btn, 'mousedown');
                    P(btn, 'pointerup');
                    M(btn, 'mouseup');
                    M(btn, 'click');
                    await sleep(200);
                    return true;
                };

                // CLICK START
                const startVis = await ensureVis(bStart);
                if (typeof startVis === 'object' && !startVis.ok) return startVis;
                if (!startVis) return { ok: false, error: `[DATES] Failed to make start date ${toMDY(bStart)} visible` };
                let vis = getVisibleRange();
                let pane = (vis.lYear === bStart.getFullYear() && vis.lMonth === bStart.getMonth()) ? leftCal : rightCal;
                console.log(`[DateLogic] Clicking Start Day: ${bStart.getDate()}`);
                const startClick = await clickDay(pane, bStart);
                if (typeof startClick === 'object' && !startClick.ok) return startClick;
                if (!startClick) return { ok: false, error: `[DATES] Failed to click start day ${bStart.getDate()}` };

                // CLICK END
                const endVis = await ensureVis(bEnd);
                if (typeof endVis === 'object' && !endVis.ok) return endVis;
                if (!endVis) return { ok: false, error: `[DATES] Failed to make end date ${toMDY(bEnd)} visible` };
                vis = getVisibleRange();
                pane = (vis.lYear === bEnd.getFullYear() && vis.lMonth === bEnd.getMonth()) ? leftCal : rightCal;
                console.log(`[DateLogic] Clicking End Day: ${bEnd.getDate()}`);
                const endClick = await clickDay(pane, bEnd);
                if (typeof endClick === 'object' && !endClick.ok) return endClick;
                if (!endClick) return { ok: false, error: `[DATES] Failed to click end day ${bEnd.getDate()}` };

                // CLOSE/VERIFY
                // Usually closes automatically or we click out? 
                // Extension logic says: let it close itself.
                await sleep(500);
                return true;
            }

            // Excecute the robust logic
            const dateParams = {
                start: new Date(sY, sM - 1, sD),
                end: new Date(eY, eM - 1, eD)
            };

            const dateResult = await setDateRangeRobust(dateParams.start, dateParams.end);
            if (!dateResult) {
                return dateResult; // Propagate detailed error if it returned an object
            }

            console.log('[Step] Date range UI interaction complete.');
            } // end main Date Range path

            // --- 4. Place of Service Logic (The Beast Part 2) ---
            currentStep = 'place_of_service';
            console.log('[Step] Setting Place of Service (12 - Home)...');

            async function selectHomeRobust() {
                const place = sel.placeOfService;
                const PLACE_ID = place.id;
                const HOME_TEXT = place.homeText;
                const HOME_VALUE = place.homeValue;

                // Local helpers for this scope
                const byXPath = (xp) => document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue || null;
                const fire = (el, type, init = {}) => el && el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
                const mouse = (el, type) => el && el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
                const keyEvt = (el, type, key = 'Enter', code = key) => el && el.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true }));
                const setNativeValue = (el, value) => {
                    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
                    if (desc?.set) desc.set.call(el, value);
                    else if (el) el.value = value;
                };

                // Strategy 1: Find by ID (Stable)
                const selectEl = document.getElementById(PLACE_ID);
                if (!selectEl) {
                    console.warn(`[selectHome] Select element #${PLACE_ID} not found!`);
                    return false;
                }

                // Strategy 1b: Find wrapper via ID relationship or closest
                // The structure is typically: .choices > .choices__inner > select
                // OR .choices__inner is a sibling in some DOMs. 
                // We trust closest('.choices') or parent traversal.
                const choices = place.choices || {};
                let inner = selectEl.closest(choices.inner || '.choices__inner');
                let root = selectEl.closest('.choices');
                if (!root && place.xpath) {
                    inner = byXPath(place.xpath);
                    if (inner) root = inner.closest('.choices') || inner.parentElement;
                }

                if (!root) {
                    // Try looking for the label and finding the neighbor?
                    // User provided HTML shows label for="provided-service-place_of_service"
                    // The container is next to it.
                    console.warn('[selectHome] Could not locate Choices root wrapper.');
                    // attempt raw select set only
                }

                // 1) Try Choices instance API (Best if available)
                const inst = selectEl.choices || selectEl._choices || selectEl._instance;
                if (inst && (typeof inst.setChoiceByValue === 'function' || typeof inst.setValue === 'function')) {
                    try {
                        if (typeof inst.setChoiceByValue === 'function') inst.setChoiceByValue(HOME_VALUE);
                        else inst.setValue([{ value: HOME_VALUE, label: HOME_TEXT }]);
                        fire(selectEl, 'change');
                        console.log('[selectHome] Set via Choices instance API');
                        return true;
                    } catch (e) {
                        console.warn('[selectHome] Choices API path failed, falling back:', e);
                    }
                }

                if (!root) {
                    // Last ditch: just set value on select and hope
                    selectEl.value = HOME_VALUE;
                    fire(selectEl, 'change');
                    return true;
                }

                // helpers to open dropdown and find list
                const openDropdown = () => {
                    const opener = root.querySelector(choices.inner || '.choices__inner') || root;
                    if (opener) {
                        mouse(opener, 'mousedown');
                        mouse(opener, 'mouseup');
                        mouse(opener, 'click');
                    }
                };

                const getList = () =>
                    root.querySelector(choices.listDropdownExpanded || '.choices__list--dropdown[aria-expanded="true"] .choices__list[role="listbox"]') ||
                    root.querySelector(choices.listDropdown || '.choices__list--dropdown .choices__list[role="listbox"]');

                // 2) UI: open dropdown and try to click the option node directly
                openDropdown();
                for (let i = 0; i < 10; i++) {
                    const list = getList();
                    if (list?.children?.length) {
                        const optSel = choices.option || '.choices__item[role="option"]';
                        let optionNode =
                            list.querySelector(`[data-value="${HOME_VALUE}"]`) ||
                            Array.from(list.querySelectorAll(optSel)).find(n => (n.textContent || '').trim().toLowerCase() === HOME_TEXT.toLowerCase()) ||
                            Array.from(list.querySelectorAll(optSel)).find(n => (n.textContent || '').toLowerCase().includes('home'));

                        if (optionNode) {
                            optionNode.scrollIntoView({ block: 'nearest' });
                            mouse(optionNode, 'mousedown');
                            mouse(optionNode, 'mouseup');
                            mouse(optionNode, 'click');
                            const val = optionNode.getAttribute('data-value') || HOME_VALUE;
                            if (selectEl && val) {
                                selectEl.value = val;
                                fire(selectEl, 'change');
                            }
                            console.log('[selectHome] Clicked option node in dropdown');
                            return true;
                        }
                    }
                    await sleep(100);
                }

                // 3) UI: type in the Choices search input and press Enter
                openDropdown();
                await sleep(80);
                const searchInput = root.querySelector(choices.searchInput || '.choices__input--cloned') || root.querySelector(choices.searchInputAlt || 'input[type="text"].choices__input');
                if (searchInput) {
                    setNativeValue(searchInput, 'home');
                    fire(searchInput, 'input');
                    fire(searchInput, 'change');
                    await sleep(120);
                    keyEvt(searchInput, 'keydown', 'Enter');
                    keyEvt(searchInput, 'keyup', 'Enter');
                    await sleep(150);

                    if (selectEl && (selectEl.value === HOME_VALUE ||
                        (selectEl.selectedOptions?.[0]?.textContent || '').toLowerCase().includes('home'))) {
                        console.log('[selectHome] Selected via search + Enter');
                        fire(selectEl, 'change');
                        return true;
                    }
                }

                // 4) Fallback: set <select> value directly and update visible text
                const byValue = selectEl.querySelector(`option[value="${HOME_VALUE}"]`);
                const byText = Array.from(selectEl.options || []).find(o => (o.textContent || '').toLowerCase().includes('home'));
                const target = byValue || byText;
                if (target) {
                    selectEl.value = target.value;
                    fire(selectEl, 'change');
                    const single = root.querySelector(choices.singleSelected || '.choices__list--single .choices__item');
                    if (single) {
                        single.textContent = (target.textContent || HOME_TEXT).trim();
                        single.classList.remove('choices__placeholder');
                        single.setAttribute('data-value', target.value);
                    }
                    console.log('[selectHome] Applied fallback to set select value directly');
                    return true;
                }
                console.warn('[selectHome] All strategies failed');
                return false;
            }

            const homeSuccess = await selectHomeRobust();
            if (!homeSuccess) {
                return { ok: false, error: '[DROPDOWN] Could not find or select "12 - Home" in the Place of Service dropdown' };
            }

            // --- 5. File Upload Logic (Browser-Side Fetch) ---
            currentStep = 'upload';
            if (isBrooklyn) {
                console.log('[Step] Brooklyn: skipping proof upload.');
            } else if (data.proofURL) {
                console.log(`[Step] Uploading file from URL: ${data.proofURL}`);

                async function uploadFileRobust(url, filename) {
                    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

                    // 1. Fetch Blob (using browser session)
                    let blob = null;
                    try {
                        const resp = await fetch(url);
                        if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
                        blob = await resp.blob();
                        console.log(`[Upload] Fetched blob size: ${blob.size}, type: ${blob.type}`);
                    } catch (e) {
                        console.error('[Upload] Failed to fetch file inside browser:', e);
                        return false;
                    }

                    // 2. Find "Attach Document" button
                    // Note: User's HTML shows specific ID: #payments-attachment-button-...
                    // But we keep the text search as fallback or primary if IDs are dynamic.
                    let attachBtn = null;
                    const attachText = (sel.proofUpload && sel.proofUpload.attachButtonText) || 'Attach Document';
                    const findBtn = () => {
                        const btns = Array.from(document.querySelectorAll('button'));
                        return btns.find(b => (b.textContent || '').includes(attachText) && b.offsetParent !== null);
                    };

                    for (let i = 0; i < 30; i++) {
                        attachBtn = findBtn();
                        if (attachBtn) break;
                        await sleep(100);
                    }
                    if (!attachBtn) { console.error('[Upload] Attach button not found'); return { ok: false, error: '[UPLOAD] Could not find "Attach Document" button' }; }

                    console.log('[Upload] Clicking Attach Document...');
                    attachBtn.click();
                    await sleep(1000);

                    // 3. Find Dialog & Input
                    let modal = null, input = null, submitBtn = null;
                    const proof = sel.proofUpload || {};
                    const modalCfg = proof.modal || {};
                    const fileCfg = proof.fileInput || {};
                    for (let i = 0; i < 30; i++) {
                        modal = document.getElementById(modalCfg.id || 'upload-payments-documents') ||
                            document.querySelector('.' + (modalCfg.classFallback || 'dialog-paper').replace(/^\./, '')) ||
                            document.querySelector(modalCfg.roleFallback || '[role="dialog"]');
                        if (modal && modal.offsetParent !== null) {
                            input = modal.querySelector('input[data-testid="' + (fileCfg.dataTestId || 'file-upload-input') + '"]');
                            if (!input) input = modal.querySelector(fileCfg.typeFallback || 'input[type="file"]');
                            submitBtn = modal.querySelector('.' + (proof.saveButtonClass || 'attach-document-dialog__actions--save').replace(/^\./, ''));

                            if (input && submitBtn) break;
                        }
                        await sleep(200);
                    }

                    if (!modal || !input) { console.error('[Upload] Upload dialog/input not found'); return { ok: false, error: '[UPLOAD] File upload dialog or input field not found' }; }

                    // 4. Set File (DataTransfer Magic)
                    // Use blob.type to support images (image/png, etc.) or PDFs automatically
                    const fileType = blob.type || 'application/octet-stream';
                    const file = new File([blob], filename, { type: fileType, lastModified: Date.now() });
                    const dt = new DataTransfer();
                    dt.items.add(file);
                    input.files = dt.files;

                    // Events to trigger React/Framework change detection
                    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));

                    console.log(`[Upload] File set in input: ${filename} (${fileType}). Waiting for validation...`);
                    await sleep(1000);

                    // 5. Click Attach
                    const disabledClass = (proof.disabledClass || 'opacity-40').replace(/^\./, '');
                    for (let i = 0; i < 30; i++) {
                        if (!submitBtn.disabled && submitBtn.getAttribute('aria-disabled') !== 'true' && !submitBtn.classList.contains(disabledClass)) {
                            console.log('[Upload] Button enabled. Clicking...');
                            submitBtn.click();
                            await sleep(2000); // Wait for upload/close
                            return true;
                        }
                        await sleep(200);
                    }
                    return { ok: false, error: '[UPLOAD] File "Attach" button remained disabled (upload might have failed)' };
                }

                const uploadOk = await uploadFileRobust(data.proofURL, data.fileName || 'proof.png');
                if (!uploadOk) {
                    return uploadOk; // Propagate detailed error
                }
            } else {
                console.log('[Step] No proofURL provided, skipping upload.');
            }

            // --- 6. Fill Dependants (If Present) ---
            currentStep = 'dependants';
            if (data.dependants && Array.isArray(data.dependants) && data.dependants.length > 0) {
                console.log('[Step] Processing Dependants:', data.dependants.length);

                // Formatter helper to align text
                // Goal: "child 1 (next line) child 2" for names
                // Goal: "child 1:       date"
                //       "child 2 long:  date"
                // Logic: 2 spaces per 1 character difference (heuristic for variable width fonts)

                let nameStr = '';
                let dobStr = '';
                let cinStr = '';

                // Calculate max name length for padding
                const maxNameLen = data.dependants.reduce((max, d) => Math.max(max, (d.name || 'Unknown').length), 0);

                data.dependants.forEach((d, idx) => {
                    const isLast = idx === data.dependants.length - 1;
                    const newline = isLast ? '' : '\n';

                    const name = d.name || 'Unknown';
                    const diff = maxNameLen - name.length;
                    const padding = ' '.repeat(Math.round(diff * 1.7)); // 1.7 spaces per char (User tuned)
                    const buffer = '  '; // Restored buffer

                    const paddedLabel = name + padding + buffer;

                    nameStr += `${name}${newline}`;
                    // Use paddedLabel for the labels in DOB and CIN fields to align values
                    dobStr += `${paddedLabel}: ${d.Birthday || ''}${newline}`;
                    cinStr += `${paddedLabel}: ${d.CIN || ''}${newline}`;
                });

                console.log('[Step] Dependants Strings Generated');
                const dep = sel.dependants || {};
                const NAME_ID = (dep.name && dep.name.id) || 'household_member_name_s_first_and_last';
                const NAME_XP = (dep.name && dep.name.xpath) || '';
                const DOB_ID = (dep.dob && dep.dob.id) || 'household_member_date_of_birth_s';
                const DOB_XP = (dep.dob && dep.dob.xpath) || '';
                const CIN_ID = (dep.cin && dep.cin.id) || 'household_member_cin_s';
                const CIN_XP = (dep.cin && dep.cin.xpath) || '';

                // Helper to fill Text area
                const fillArea = (id, xp, value) => {
                    const el = document.getElementById(id) || byXPath(xp);
                    if (el) {
                        el.focus();
                        setNativeValue(el, value);
                        fire(el, 'input');
                        fire(el, 'change');
                        el.blur();
                        return true;
                    }
                    return false;
                };

                if (fillArea(NAME_ID, NAME_XP, nameStr)) console.log('Filled Dependant Names');
                else console.warn('Failed to find Dependant Name Field');

                if (fillArea(DOB_ID, DOB_XP, dobStr)) console.log('Filled Dependant DOBs');
                else console.warn('Failed to find Dependant DOB Field');

                if (fillArea(CIN_ID, CIN_XP, cinStr)) console.log('Filled Dependant CINs');
                else console.warn('Failed to find Dependant CIN Field');

            } else {
                console.log('[Step] No dependants to process.');
            }

            // --- Brooklyn interaction note ---
            if (isBrooklyn) {
                currentStep = 'interaction_note';
                const noteCfg = sel.interactionNote || {};
                const noteId = noteCfg.id || 'interactionNote';
                const noteEl = document.getElementById(noteId);
                if (!noteEl) {
                    return { ok: false, error: '[NOTE] Brooklyn interaction note textarea #' + noteId + ' not found' };
                }
                const formatNoteDate = (iso) => {
                    const [y, m, d] = String(iso).split('-').map(Number);
                    return new Date(y, m - 1, d).toLocaleDateString('en-US', {
                        month: 'long',
                        day: 'numeric',
                        year: 'numeric'
                    });
                };
                const orderUrlLines = (Array.isArray(data.orderURLs) ? data.orderURLs : [])
                    .map((u) => String(u || '').trim())
                    .filter(Boolean);
                let noteText = `Services provided for the week of ${formatNoteDate(startStr)} through ${formatNoteDate(endStr)}`;
                if (orderUrlLines.length > 0) {
                    noteText += '\n\n' + orderUrlLines.join('\n');
                }
                console.log('[Step] Brooklyn note:', noteText);
                noteEl.focus();
                setNativeValue(noteEl, noteText);
                fire(noteEl, 'input');
                fire(noteEl, 'change');
                noteEl.blur();
            }


            // --- 4. Submit ---
            currentStep = 'submit';
            const submitId = (sel.submit && sel.submit.id) || 'fee-schedule-provided-service-post-note-btn';
            const submitBtn = document.getElementById(submitId);

            if (!submitInvoice) {
                console.log('[Step] Submit skipped (testing): waiting for Continue bar click...');
                if (!submitBtn) {
                    return { ok: false, error: '[SUBMIT] Submit disabled but could not find Post button (expected for inspection)' };
                }

                await new Promise((resolve) => {
                    const existing = document.getElementById('automation-test-continue-bar');
                    if (existing) existing.remove();

                    const clientLabel = (data.name || 'client').trim();
                    const bar = document.createElement('div');
                    bar.id = 'automation-test-continue-bar';
                    bar.setAttribute('role', 'banner');
                    bar.style.cssText = [
                        'position:fixed',
                        'top:0',
                        'left:0',
                        'right:0',
                        'z-index:2147483647',
                        'display:flex',
                        'align-items:center',
                        'justify-content:center',
                        'gap:16px',
                        'padding:12px 20px',
                        'background:#1e3a5f',
                        'color:#fff',
                        'font:600 15px/1.4 system-ui,-apple-system,Segoe UI,sans-serif',
                        'box-shadow:0 4px 16px rgba(0,0,0,.35)',
                        'border-bottom:3px solid #f59e0b'
                    ].join(';');

                    const text = document.createElement('span');
                    text.textContent = `Test mode — review billing for ${clientLabel}. Post was not clicked.`;

                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.id = 'automation-test-continue-btn';
                    btn.textContent = 'Continue to next client →';
                    btn.style.cssText = [
                        'cursor:pointer',
                        'border:none',
                        'border-radius:6px',
                        'padding:10px 18px',
                        'background:#f59e0b',
                        'color:#1e3a5f',
                        'font:700 14px/1 system-ui,-apple-system,Segoe UI,sans-serif',
                        'box-shadow:0 2px 6px rgba(0,0,0,.2)'
                    ].join(';');

                    const finish = () => {
                        bar.remove();
                        resolve();
                    };
                    btn.addEventListener('click', finish, { once: true });

                    bar.appendChild(text);
                    bar.appendChild(btn);
                    document.body.prepend(bar);
                });

                return { ok: true, amount, days, verified: false, submitSkipped: true };
            }

            console.log('[Step] Submitting billing record...');
            if (submitBtn) {
                clickLikeHuman(submitBtn);
                console.log('[Step] Submit button FOUND and clicked.');
                await sleep(3000); // Wait for UI to react

                // --- 5. Verify Success ---
                console.log('[Step] Verifying submission...');
                let found = false;
                for (let i = 0; i < 20; i++) {
                    if (doInlineScanFallback(verifyStart, verifyEnd, amount)) {
                        found = true;
                        break;
                    }
                    await sleep(500);
                }

                if (found) {
                    return { ok: true, amount, days, verified: true };
                } else {
                    console.warn('[Step] Verification failed: New record not found after submit.');
                    return { ok: true, amount, days, verified: false, warning: 'Billing attempted but not verified in list' };
                }
            } else {
                return { ok: false, error: '[SUBMIT] Could not find final "Post" button to submit billing record' };
            }

            } catch (e) {
                const msg = (e && e.message) || String(e);
                const type = classifyError(msg);
                throw new Error('[STEP:' + currentStep + '] [TYPE:' + type + '] ' + msg);
            }

            // =========================================================================
            //  INJECTED LOGIC END
            // =========================================================================
        }, { data: requestData, sel, submitInvoice });

        return result;

    } catch (e) {
        return { ok: false, error: e.message };
    }
}

module.exports = { executeBillingOnPage, countExistingBillingRecordsOnPage };
