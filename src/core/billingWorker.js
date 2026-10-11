const { performLoginSequence } = require('./auth');
const axios = require('axios');
const { executeBillingOnPage, countExistingBillingRecordsOnPage } = require('./billingActions');
const { getPage, restartBrowser } = require('./browser');
const uniteSelectors = require('../uniteSelectors');
const billingSession = require('./billingSession');
const fs = require('fs');
const path = require('path');

const { safeLoadDotenv } = require('../safeDotenv');

// Load .env from DOTENV_PATH (packaged app) or server-side-automation root
const dotenvPath = process.env.DOTENV_PATH || path.join(__dirname, '..', '..', '.env');
safeLoadDotenv(dotenvPath);

const {
    buildClientInvoicePdfUrl,
    mergeCustomInvoiceForRequest,
    validateCustomInvoiceGlobalParams,
    validateCustomInvoiceParams
} = require('./clientInvoicePdf');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Pull delivery date from API row — tries camelCase, snake_case, and common alternates. */
function extractDeliveryDateFromRow(r) {
    if (!r || typeof r !== 'object') return null;
    const candidates = [
        r.deliveryDate,
        r.delivery_date,
        r['Delivery Date'],
        r.serviceDate,
        r.service_date,
        r.delivery
    ];
    for (const raw of candidates) {
        if (raw == null) continue;
        const s = String(raw).trim();
        if (ISO_DATE_RE.test(s)) return s;
    }
    return null;
}

/** Console summary of deliveryDate presence — helps debug machine-specific API / settings drift. */
function logDeliveryDateQueueStats(label, rows, extra = {}) {
    const list = Array.isArray(rows) ? rows : [];
    const valid = list.filter((r) => r.deliveryDate && ISO_DATE_RE.test(String(r.deliveryDate)));
    const missing = list.filter((r) => !r.deliveryDate || !ISO_DATE_RE.test(String(r.deliveryDate)));
    const suffix = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
    console.log(`[DATES] ${label}: ${valid.length}/${list.length} rows have valid deliveryDate (YYYY-MM-DD).${suffix}`);
    if (missing.length > 0) {
        const sample = missing.slice(0, 8).map((r) => ({
            name: r.name,
            date: r.date,
            endDate: r.endDate,
            deliveryDate: r.deliveryDate,
            dateLikeKeys: Object.keys(r).filter((k) => /date|delivery|service/i.test(k))
        }));
        console.warn(`[DATES] ${label}: ${missing.length} row(s) missing/invalid deliveryDate. Sample:`, JSON.stringify(sample));
    }
}

function describeReqDateFields(req) {
    if (!req || typeof req !== 'object') return {};
    return {
        name: req.name,
        startDate: req.startDate,
        date: req.date,
        endDate: req.endDate,
        start: req.start,
        end: req.end,
        deliveryDate: req.deliveryDate,
        deliveryDateType: req.deliveryDate == null ? 'null/undefined' : typeof req.deliveryDate,
        isBrooklyn: req.isBrooklyn,
        id: req.id
    };
}

// --- CREDENTIALS: account=brooklyn (API) → UniteUs Brooklyn logins ---
function isBrooklynAccount(apiConfig) {
    return apiConfig != null
        && String(apiConfig.account || '').trim().toLowerCase() === 'brooklyn';
}

function getUniteUsCredentials(apiConfig) {
    if (isBrooklynAccount(apiConfig)) {
        const email = process.env.UNITEUS_EMAIL_BROOKLYN || process.env.UNITEUS_EMAIL;
        const password = process.env.UNITEUS_PASSWORD_BROOKLYN || process.env.UNITEUS_PASSWORD;
        return { email, password };
    }
    return {
        email: process.env.UNITEUS_EMAIL,
        password: process.env.UNITEUS_PASSWORD
    };
}

function uniteCredsMissingHint(apiConfig) {
    if (isBrooklynAccount(apiConfig)) return ' (Brooklyn: set UNITEUS_EMAIL_BROOKLYN / UNITEUS_PASSWORD_BROOKLYN)';
    return ' (set UNITEUS_EMAIL / UNITEUS_PASSWORD)';
}

// --- API CONFIG DEFAULTS ---
const CUSTOMER_API_BASE = 'https://customer.thedietfantasy.com';
const DEFAULT_API_BASE_URL = CUSTOMER_API_BASE;
const DEFAULT_API_KEY = process.env.EXTENSION_API_KEY || 'ZestoPresto';

function normalizeCustomerApiUrl(urlStr) {
    if (urlStr == null || typeof urlStr !== 'string') return urlStr;
    const t = urlStr.trim();
    if (!t || !/thedietfantasy\.com/i.test(t)) return urlStr;
    return t.replace(/https?:\/\/(?:brooklyn|monsey)\.thedietfantasy\.com/gi, CUSTOMER_API_BASE);
}

/** First proof URL string from queue row (invoice API or legacy). */
function firstProofUrlRaw(req) {
    if (Array.isArray(req.proofURLs) && req.proofURLs.length > 0 && req.proofURLs[0]) {
        return String(req.proofURLs[0]);
    }
    if (req.proofURL) return String(req.proofURL);
    return '';
}

function resolveApiInvoiceUrl(req, isProduce) {
    const url = isProduce ? req.produceInvoice : req.mealInvoice;
    return url ? String(url).trim() : '';
}

/** Use client invoice PDF flow: custom invoice params, meal/produce invoice links, legacy proof, or invoice list mode. */
function wantsClientInvoicePdf(req, customInvoicesMode = false, customInvoiceParams = null) {
    if (customInvoicesMode && customInvoiceParams) return true;
    if (req.mealInvoice || req.produceInvoice) return true;
    if (firstProofUrlRaw(req)) return true;
    return req.useClientInvoicePdf === true;
}

function resolveInvoicePdfHttpUrl(req, baseUrl, customInvoicesMode = false, customInvoiceParams = null, isProduce = false) {
    if (customInvoicesMode && customInvoiceParams) {
        const merged = mergeCustomInvoiceForRequest(req, customInvoiceParams, baseUrl);
        return buildClientInvoicePdfUrl(baseUrl, merged);
    }
    const apiInvoice = resolveApiInvoiceUrl(req, isProduce);
    if (apiInvoice) {
        return resolveClientInvoicePdfHttpUrl(normalizeCustomerApiUrl(apiInvoice), baseUrl);
    }
    const raw = firstProofUrlRaw(req);
    if (!raw) return null;
    return resolveClientInvoicePdfHttpUrl(normalizeCustomerApiUrl(raw), baseUrl);
}

/** Resolve relative invoice PDF path against Diet Fantasy API base (browser would hit CORS from UniteUs; we fetch in Node). */
function resolveClientInvoicePdfHttpUrl(raw, baseUrl) {
    const t = String(raw || '').trim();
    if (!t) return null;
    if (/^https?:\/\//i.test(t)) return t;
    const base = (baseUrl || DEFAULT_API_BASE_URL).replace(/\/$/, '');
    const path = t.startsWith('/') ? t : `/${t}`;
    try {
        return new URL(path, `${base}/`).toString();
    } catch {
        return base + path;
    }
}

function isProduceServiceType(serviceType) {
    return String(serviceType || '').toLowerCase().includes('produce');
}

function parseApiAmount(val) {
    if (val == null || val === '') return null;
    if (typeof val === 'number' && Number.isFinite(val)) return val > 0 ? val : null;
    const n = parseFloat(String(val).replace(/[$,]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
}

function resolveApiBillingAmount(req, isProduce) {
    return isProduce ? parseApiAmount(req.produceAmount) : parseApiAmount(req.mealAmount);
}

/** Inclusive calendar days between two UTC midnight Dates. */
function inclusiveUtcDayCount(startUtc, endUtc) {
    return Math.floor((endUtc - startUtc) / (1000 * 60 * 60 * 24)) + 1;
}

/**
 * Food (non-produce) amount clamp: weekly amount is billed as amount/7 per day.
 * Subtract one daily share for each day removed by date clamping.
 * @returns {{ amount: number, daysRemoved: number, dailyRate: number } | null} null if no change
 */
function clampFoodAmountForRemovedDays(amount, originalStartUtc, originalEndUtc, finalStartUtc, finalEndUtc) {
    if (!Number.isFinite(amount) || amount <= 0) return null;
    if (!originalStartUtc || !originalEndUtc || !finalStartUtc || !finalEndUtc) return null;
    const origDays = inclusiveUtcDayCount(originalStartUtc, originalEndUtc);
    const finalDays = inclusiveUtcDayCount(finalStartUtc, finalEndUtc);
    const daysRemoved = origDays - finalDays;
    if (daysRemoved <= 0) return null;
    const dailyRate = amount / 7;
    const next = Math.round((amount - dailyRate * daysRemoved) * 100) / 100;
    return { amount: next, daysRemoved, dailyRate };
}

/** Produce clients bill from API `date`; meal clients from API `startDate`. */
function resolveBillingStartIso(req, isProduce) {
    const primary = isProduce ? req.date : req.startDate;
    if (primary && ISO_DATE_RE.test(String(primary))) return String(primary);
    const fallback = isProduce ? req.startDate : req.date;
    if (fallback && ISO_DATE_RE.test(String(fallback))) return String(fallback);
    return null;
}

function appendProduceQueryParam(urlStr, isProduce) {
    if (!isProduce || !urlStr) return urlStr;
    try {
        const u = new URL(urlStr);
        u.searchParams.set('produce', '1');
        return u.toString();
    } catch {
        return urlStr.includes('?') ? `${urlStr}&produce=1` : `${urlStr}?produce=1`;
    }
}

/**
 * Download invoice PDF from app server, return data URL for in-page upload (avoids cross-origin fetch from UniteUs).
 */
async function loadClientInvoiceProofAsDataUrl(
    req, authInfo, apiConfig, emitEvent, slotLabel, customInvoicesMode = false, customInvoiceParams = null
) {
    const baseUrl = apiConfig?.baseUrl || DEFAULT_API_BASE_URL;
    if (customInvoicesMode && customInvoiceParams) {
        const globalErr = validateCustomInvoiceGlobalParams(customInvoiceParams);
        if (globalErr) {
            const err = new Error(`[PROOF] ${globalErr}`);
            err.code = 'CUSTOM_INVOICE_INVALID';
            throw err;
        }
        const merged = mergeCustomInvoiceForRequest(req, customInvoiceParams, baseUrl);
        const rowErr = validateCustomInvoiceParams(merged);
        if (rowErr) {
            const err = new Error(`[PROOF] ${req.name || 'Client'}: ${rowErr}`);
            err.code = 'CUSTOM_INVOICE_INVALID';
            throw err;
        }
    }
    const isProduce = isProduceServiceType(authInfo?.serviceType);
    let httpUrl = resolveInvoicePdfHttpUrl(req, baseUrl, customInvoicesMode, customInvoiceParams, isProduce);
    if (!httpUrl) {
        const invoiceField = isProduce ? 'produceInvoice' : 'mealInvoice';
        const err = new Error(`[PROOF] Client invoice PDF URL missing (expected ${invoiceField}, proofURLs[0], or custom invoice fields)`);
        err.code = 'INVOICE_PDF_FETCH_FAILED';
        throw err;
    }
    const usedApiInvoice = !customInvoicesMode && !!resolveApiInvoiceUrl(req, isProduce);
    if (!customInvoicesMode && !usedApiInvoice) {
        httpUrl = appendProduceQueryParam(httpUrl, isProduce);
    }
    const prefix = slotLabel ? `[${slotLabel}] ` : '';
    if (emitEvent) {
        const source = customInvoicesMode
            ? 'custom invoice'
            : usedApiInvoice
                ? (isProduce ? 'produceInvoice' : 'mealInvoice')
                : 'proof link';
        emitEvent('log', {
            message: `${prefix}${req.name || 'Client'}: Downloading client invoice PDF (${source})…`,
            type: 'info'
        });
    }
    try {
        const res = await axios.get(httpUrl, { responseType: 'arraybuffer', timeout: 120000, maxContentLength: 50 * 1024 * 1024 });
        if (res.status < 200 || res.status >= 300) {
            const err = new Error(`[PROOF] Client invoice PDF HTTP ${res.status}`);
            err.code = 'INVOICE_PDF_FETCH_FAILED';
            throw err;
        }
        const ct = (res.headers && res.headers['content-type']) || 'application/pdf';
        const b64 = Buffer.from(res.data).toString('base64');
        return { dataUrl: `data:${ct};base64,${b64}` };
    } catch (e) {
        if (e.code === 'INVOICE_PDF_FETCH_FAILED') throw e;
        const err = new Error(`[PROOF] Client invoice PDF fetch failed: ${e.message}`);
        err.code = 'INVOICE_PDF_FETCH_FAILED';
        throw err;
    }
}

/** Parse structured error message from billing flow. Returns { step, type, details } for clear logging. */
function parseBillingError(message) {
    const msg = String(message || '');
    const stepMatch = msg.match(/\[STEP:([^\]]+)\]/);
    const typeMatch = msg.match(/\[TYPE:([^\]]+)\]/);
    let details = msg
        .replace(/\[STEP:[^\]]+\]\s*/, '')
        .replace(/\[TYPE:[^\]]+\]\s*/, '')
        .trim();
    const step = stepMatch ? stepMatch[1] : (msg.includes('closed') || msg.includes('page.goto') ? 'navigation' : 'unknown');
    const type = typeMatch ? typeMatch[1] : (msg.includes('closed') || msg.includes('has been closed') ? 'BROWSER_CLOSED' : (msg.includes('timeout') ? 'TIMEOUT' : 'UNKNOWN'));
    return { step, type, details: details || msg };
}

/** Comma-separated unit amounts from each matched Unite invoice card (e.g. $1,008.00, $864.00). */
function formatCheckOnlyBillAmounts(matchedInvoices, results) {
    if (Array.isArray(matchedInvoices) && matchedInvoices.length > 0) {
        return matchedInvoices.map((inv) => inv.amount || '—').join(', ');
    }
    if (!Array.isArray(results)) return '';
    const amounts = [];
    for (const r of results) {
        if (Array.isArray(r.amounts)) amounts.push(...r.amounts);
    }
    return amounts.join(', ');
}

function formatPageCardStartsHint(pageCardStarts, max = 6) {
    if (!Array.isArray(pageCardStarts) || pageCardStarts.length === 0) return '';
    const slice = pageCardStarts.slice(0, max);
    const tail = pageCardStarts.length > max ? ` (+${pageCardStarts.length - max} more)` : '';
    return ` on-page starts: ${slice.join(', ')}${tail}`;
}

/** ISO start/end for check-only: clamped billing range, queue row dates, or list download filter. */
function resolveCheckOnlyRangeIso(req) {
    const iso = (v) => v != null && ISO_DATE_RE.test(String(v)) ? String(v) : null;
    const start = iso(req.start) || iso(req.startDate) || iso(req.date) || iso(req.listFilterStart);
    const end = iso(req.end) || iso(req.endDate) || iso(req.listFilterEnd);
    return { start, end };
}

function formatCheckOnlyStatusMessage(results, scanMeta, pageCardStarts, checkOnlyDebugDates) {
    const onPage = Number(scanMeta?.cards) || 0;
    const pageHint = formatPageCardStartsHint(pageCardStarts);

    if (!results || results.length === 0) {
        return checkOnlyDebugDates.length > 0
            ? 'Check-only: (no valid dates)'
            : `Check-only: 0 (${onPage} on page${pageHint})`;
    }
    if (results.length === 1) {
        const c = results[0].count;
        const rangeLabel =
            results[0].end && results[0].end !== results[0].start
                ? `${results[0].start}–${results[0].end}`
                : results[0].start;
        if (c === 0 && onPage > 0) {
            return `Check-only: 0 for ${rangeLabel} (${onPage} on page${pageHint})`;
        }
        if (results[0].end && results[0].end !== results[0].start) {
            return `Check-only: ${c} (${rangeLabel})`;
        }
        return `Check-only: ${c}`;
    }
    const parts = results.map((r) => `${r.start}→${r.count}`);
    if (onPage > 0 && results.every((r) => r.count === 0)) {
        return `Check-only: ${parts.join(', ')} (${onPage} on page${pageHint})`;
    }
    return `Check-only: ${parts.join(', ')}`;
}

/** Unite case pages rarely reach networkidle; wait for DOM then optional short idle. */
async function navigateToClientCasePage(page, url, timeoutMs = 90000) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    try {
        await page.waitForLoadState('networkidle', { timeout: 20000 });
    } catch {
        /* continuous polling on Unite — same as auth.js */
    }
}

// --- Helpers for API ---
async function fetchRequestsFromApi(config) {
    const baseUrl = config?.baseUrl || DEFAULT_API_BASE_URL;
    const key = config?.key || DEFAULT_API_KEY;

    // Mask key for logging: show first 4 chars
    const maskedKey = key.length > 4 ? `${key.substring(0, 4)}...` : '(empty)';
    console.log(`[API] GET ${baseUrl}/api/extension/billing-requests`);
    console.log(`[API] Using Token: Bearer ${maskedKey}`);

    try {
        const res = await axios.get(`${baseUrl}/api/extension/billing-requests`, {
            headers: { 'Authorization': `Bearer ${key}` }
        });

        if (!Array.isArray(res.data)) {
            console.error('[API] Unexpected response format:', typeof res.data);
            if (typeof res.data === 'string' && res.data.trim().startsWith('<')) {
                throw new Error('Received HTML instead of JSON. Check API URL.');
            }
            throw new Error(`Expected array, got ${typeof res.data}`);
        }

        return res.data;
    } catch (err) {
        console.error('[API] Fetch Error:', err.message);
        if (err.response) {
            console.error('[API] Response Status:', err.response.status);
            console.error('[API] Response Data:', JSON.stringify(err.response.data).substring(0, 200));
        }
        throw err;
    }
}

/**
 * Wait until the same authorized-table cells the injected script uses (delivery date range + amount) are visible.
 * Avoids scraping empty strings when the shell has painted but the table is still hydrating.
 */
async function waitForAuthorizedTableVisible(page, timeoutMs = 20000) {
    const { date, amount } = uniteSelectors.billing.authorizedTable;
    const dateSel = '#' + date.id;
    const amountSel = '#' + amount.id;
    await Promise.all([
        page.waitForSelector(dateSel, { state: 'visible', timeout: timeoutMs }),
        page.waitForSelector(amountSel, { state: 'visible', timeout: timeoutMs })
    ]);
}

function authScrapeLooksUnready(auth) {
    const dates = String(auth?.authorizedDates || '').trim();
    const amtRaw = String(auth?.authorizedAmount || '').trim();
    return !dates || !amtRaw;
}

/**
 * Waits for the authorized table, scrapes, and re-scrapes a few times if main cells still look empty.
 */
async function fetchAuthDetailsFromPageWhenReady(page) {
    const waitMs = 20000;
    const maxExtraAttempts = 3;
    const pauseMs = 1500;
    try {
        await waitForAuthorizedTableVisible(page, waitMs);
        console.log('[Worker] Authorized table (date + amount) visible; scraping auth details...');
    } catch (e) {
        console.warn('[Worker] Timed out waiting for authorized table visibility:', e.message);
        console.warn('[Worker] Scraping auth details anyway (may be empty)...');
    }
    let auth = await fetchAuthDetailsFromPage(page);
    for (let i = 0; i < maxExtraAttempts && authScrapeLooksUnready(auth); i++) {
        console.log(`[Worker] Auth scrape missing date range or amount; retry ${i + 1}/${maxExtraAttempts} after ${pauseMs}ms...`);
        await sleep(pauseMs);
        auth = await fetchAuthDetailsFromPage(page);
    }
    return auth;
}

function parseCreatedAtFromRequest(req) {
    const raw = req.createdAt ?? req.created_at ?? req['Created At'];
    if (raw == null || String(raw).trim() === '') return null;
    const s = String(raw).trim();
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) {
        return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
    }
    const t = Date.parse(s);
    if (Number.isNaN(t)) return null;
    const d = new Date(t);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Client-created clamp mode: compares JSON created-at to scraped case Date Opened and billing week (req.start–req.end).
 * @returns {{ action: 'continue' } | { action: 'fail', error: Error } | { action: 'skip', message: string }}
 */
function evaluateClientCreatedClampRules(req, authInfo, dateOpenedUtc) {
    const createdAt = parseCreatedAtFromRequest(req);
    if (!createdAt) {
        const err = new Error(
            '[CREATED_AT] Missing client created date on request (expected createdAt, created_at, or "Created At").'
        );
        err.code = 'CREATED_AT_INVALID';
        return { action: 'fail', error: err };
    }
    if (!dateOpenedUtc) {
        const err = new Error(
            '[CREATED_AT] Could not parse Date Opened from page; required for Client created date clamp mode.'
        );
        err.code = 'CREATED_AT_INVALID';
        return { action: 'fail', error: err };
    }
    if (createdAt.getTime() < dateOpenedUtc.getTime()) {
        const isoC = createdAt.toISOString().split('T')[0];
        const err = new Error(
            `[CREATED_AT] Client created date (${isoC}) is before case Date Opened (${authInfo.dateOpened || '—'}).`
        );
        err.code = 'CREATED_BEFORE_CASE_OPEN';
        return { action: 'fail', error: err };
    }

    const weekStart = new Date(req.start + 'T00:00:00Z');
    const weekEnd = new Date(req.end + 'T00:00:00Z');

    if (dateOpenedUtc.getTime() < weekStart.getTime()) {
        return { action: 'continue' };
    }
    if (dateOpenedUtc.getTime() > weekEnd.getTime()) {
        return {
            action: 'skip',
            message: `Skipped: case opened after this billing week (${req.start}–${req.end}). Not billing this period.`
        };
    }
    return {
        action: 'skip',
        message:
            'Skipped: case opened inside the selected billing week — bill manually (client created date rules; partial week not automated).'
    };
}

/**
 * Scrapes authorization details (Date Opened, Authorized End Date, Max Amount) from the UniteUs page.
 */
async function fetchAuthDetailsFromPage(page) {
    console.log('[Worker] Scraping auth details from page...');
    const authSel = uniteSelectors.billing.authorizedTable;
    try {
        const auth = await page.evaluate((authSel) => {
            const byXPath = (xp) =>
                document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue || null;
            const norm = (s) => String(s || "").trim();

            let datesEl = document.querySelector('#' + authSel.date.id);
            if (!datesEl && authSel.date.xpath) datesEl = byXPath(authSel.date.xpath);

            let dateOpenedEl = document.querySelector('#' + authSel.dateOpened.id);
            if (!dateOpenedEl && authSel.dateOpened.xpath) dateOpenedEl = byXPath(authSel.dateOpened.xpath);

            let amountEl = document.querySelector('#' + authSel.amount.id);
            if (!amountEl && authSel.amount.xpath) amountEl = byXPath(authSel.amount.xpath);

            const stSel = authSel.serviceType || {};
            const stId = stSel.id || 'basic-table-service-type-value';
            let serviceTypeEl = document.getElementById(stId);
            if (!serviceTypeEl && stSel.xpath) serviceTypeEl = byXPath(stSel.xpath);

            const datesText = norm(datesEl?.textContent);
            const dateOpenedP = dateOpenedEl?.querySelector('p.service-case-program-entry__text');
            const dateOpenedText = norm(dateOpenedP ? dateOpenedP.textContent : dateOpenedEl?.textContent);
            const amountText = norm(amountEl?.textContent);
            const serviceType = norm(serviceTypeEl ? serviceTypeEl.textContent || serviceTypeEl.innerText : '');

            return {
                authorizedDates: datesText,
                dateOpened: dateOpenedText,
                authorizedAmount: amountText,
                serviceType
            };
        }, authSel);
        console.log('[Worker] Scraped auth details:', auth);
        return auth;
    } catch (err) {
        console.error('[Worker] Failed to scrape auth details:', err.message);
        return { authorizedDates: "", dateOpened: "", authorizedAmount: "", serviceType: "" };
    }
}

/**
 * Scrapes client details (name, phone, address) from the UniteUs page.
 * Ported from personInfo.js logic.
 */
async function fetchClientDetailsFromPage(page) {
    console.log('[Worker] Scraping client details from page...');
    try {
        // Wait for name to appear at least
        try {
            await page.waitForSelector('.contact-column__name', { timeout: 10000 });
        } catch (e) {
            console.warn('[Worker] Name selector not found, attempting to scrape anyway.');
        }

        const details = await page.evaluate(() => {
            const norm = (s) => String(s || "").trim();
            const digits = (s) => String(s || "").replace(/\D+/g, "");

            function parseName() {
                const h = document.querySelector(".contact-column__name");
                return norm(h?.textContent) || "";
            }

            function parsePhone() {
                const span = document.querySelector("[data-test-element='phone-numbers_number_0']");
                let raw = norm(span?.textContent);
                if (!raw) {
                    const a = document.querySelector(".ui-contact-information__compact-phone a[href^='tel:']");
                    raw = norm(a?.textContent || a?.getAttribute?.("href")?.replace(/^tel:/, ""));
                }
                const d = digits(raw);
                if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
                if (d.length === 11 && d.startsWith("1")) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
                return raw || "";
            }

            function parseAddress() {
                const details = document.querySelector(".address .address__details");
                if (details) {
                    const ps = Array.from(details.querySelectorAll("p")).map(p => norm(p.textContent)).filter(Boolean);
                    const filtered = ps.filter(line => !/^primary$/i.test(line) && !/county$/i.test(line));
                    return filtered.join(", ").replace(/\s{2,}/g, " ").replace(/\s,/, ",");
                }
                const addrEl = document.querySelector(".address");
                return norm(addrEl?.textContent).replace(/\s{2,}/g, " ") || "";
            }

            return {
                name: parseName(),
                phone: parsePhone(),
                address: parseAddress()
            };
        });
        console.log('[Worker] Scraped details:', details);
        return details;
    } catch (err) {
        console.error('[Worker] Failed to scrape client details:', err.message);
        return { name: "", phone: "", address: "" };
    }
}

/**
 * Generates a proof URL (PDF as Data URI) using the Diet Fantasy API.
 */
async function generateProofUrl(clientDetails, requestData, config) {
    const baseUrl = config?.baseUrl || DEFAULT_API_BASE_URL;
    const url = `${baseUrl}/api/ext/attestation`;

    console.log(`[API] Generating attestation at ${url}`);

    const payload = {
        name: clientDetails.name || requestData.name || "Attestation",
        phone: clientDetails.phone || "",
        address: clientDetails.address || "",
        deliveryDate: requestData.deliveryDate || requestData.start,
        startDate: requestData.start,
        endDate: requestData.end,
        attestationDate: new Date().toISOString().slice(0, 10),
        userId: requestData.userId || requestData['client#'] || null,
        clientId: requestData['client#'] || null
    };

    try {
        const res = await axios.post(url, payload, {
            responseType: 'arraybuffer'
        });

        const contentType = res.headers['content-type'] || 'application/pdf';
        const base64 = Buffer.from(res.data).toString('base64');
        return `data:${contentType};base64,${base64}`;
    } catch (err) {
        if (err.response && err.response.status === 404) {
            console.error('[API] Attestation Generation: No file found (404). skipping.');
            const error = new Error('[API] No attestation file available for this client');
            error.code = 'NO_ATTESTATION_FILE';
            throw error;
        }
        if (err.response && err.response.status === 409) {
            console.error('[API] Attestation Generation: Conflict/No Signature (409). skipping.');
            const error = new Error('[API] No signature available / Conflict detected');
            error.code = 'NO_SIGNATURE';
            throw error;
        }
        if (err.response && err.response.status === 422) {
            let detail = 'Invalid request data';
            try {
                // If response is arraybuffer, we might need to decode it to see JSON error
                if (err.response.data instanceof ArrayBuffer || Buffer.isBuffer(err.response.data)) {
                    const str = Buffer.from(err.response.data).toString();
                    const parsed = JSON.parse(str);
                    detail = parsed.error || parsed.message || detail;
                } else {
                    detail = err.response.data?.error || err.response.data?.message || detail;
                }
            } catch (e) { /* ignore parse error */ }

            console.error(`[API] Attestation Generation: Validation Error (422): ${detail}. skipping.`);
            const error = new Error(`[API] Validation Failed: ${detail}`);
            error.code = 'VALIDATION_ERROR';
            throw error;
        }
        console.error('[API] Attestation Generation Error:', err.message);
        throw err;
    }
}

async function updateOrderStatus(orderNumber, status, config) {
    if (!orderNumber) return;
    const baseUrl = config?.baseUrl || DEFAULT_API_BASE_URL;
    const key = config?.key || DEFAULT_API_KEY;

    console.log(`[API] Updating Order #${orderNumber} -> ${status}`);
    try {
        await axios.post(`${baseUrl}/api/extension/update-status`, {
            orderNumber: orderNumber,
            status: status
        }, {
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json'
            }
        });
        console.log(`[API] Status updated.`);
    } catch (err) {
        console.error(`[API] Update Failed for #${orderNumber}:`, err.message);
    }
}

/** Call update-status for all orders in this request (orderNumbers array from /api/bill, or legacy single orderNumber). */
async function updateOrderStatusForRequest(req, status, config) {
    if (!config) return;
    const orderNumbers = Array.isArray(req.orderNumbers) ? req.orderNumbers : (req.orderNumber != null ? [req.orderNumber] : []);
    for (const num of orderNumbers) {
        if (num != null && num !== '') await updateOrderStatus(num, status, config);
    }
}

/**
 * Main worker entry point.
 * @param {Array} requests - (Legacy) requests if passed directly, or null if using internal fetch
 * @param {function} emitEvent - Function to emit socket events
 * @param {string} source - 'file' (default) or 'api'
 * @param {object} apiConfig - API base URL and key for update-status
 * @param {object} options - Optional: { page, context, getPageOrRestart, requestSlice, slotLabel } for parallel mode
 */
async function billingWorker(initialRequests, emitEvent, source = 'file', apiConfig = null, options = {}) {
    const creds = getUniteUsCredentials(apiConfig);
    if (!creds.email || !creds.password) {
        const hint = uniteCredsMissingHint(apiConfig);
        emitEvent('log', { message: '[AUTH] Missing UniteUs credentials in env.' + hint, type: 'error' });
        return;
    }
    const EMAIL = creds.email;
    const PASSWORD = creds.password;
    const baseUrl = (apiConfig && apiConfig.baseUrl) || DEFAULT_API_BASE_URL;
    const brooklynRun = isBrooklynAccount(apiConfig);
    emitEvent('log', { message: `Initializing Billing Cycle (Source: ${source}, API: ${baseUrl}, UniteUs: ${EMAIL})...` });
    console.log('[DATES] Run config:', JSON.stringify({
        source,
        apiBaseUrl: baseUrl,
        brooklynProcessingMode: brooklynRun,
        requestCount: (initialRequests || []).length
    }));
    if (brooklynRun) {
        console.log('[DATES] Brooklyn processing mode ON — every row needs deliveryDate (YYYY-MM-DD) from the client list API.');
    }


    // --- Load Requests based on Source ---
    let requests = initialRequests || [];
    if (!initialRequests || initialRequests.length === 0) {
        try {
            if (source === 'api') {
                requests = await fetchRequestsFromApi(apiConfig);
                if (!requests || requests.length === 0) {
                    emitEvent('log', { message: 'No pending requests found from API.' });
                    return;
                }
            } else {
                // Default: File loading logic (if not passed in)
                // If called from server.js with data, this block is skipped. 
                // But if we want to reload, we can. For now assume server.js passed it if 'file'.
                if (!requests || requests.length === 0) {
                    emitEvent('log', { message: 'No requests provided for file mode.' });
                    return;
                }
            }
        } catch (err) {
            emitEvent('error', { message: `Failed to load requests: ${err.message}` });
            return;
        }
    }

    const fullRequests = requests;
    const toProcess = options.requestSlice || requests;
    const resumeMode = options.resume === true;
    const slotLabel = options.slotLabel || '';
    const slotIndex = options.slotIndex ?? 0;
    const uploadAttestations = options.uploadAttestations !== false;
    const checkOnlyMode = options.checkOnlyMode === true;
    const customInvoicesMode = options.customInvoices === true;
    const customInvoiceParams = customInvoicesMode && options.customInvoiceParams
        ? options.customInvoiceParams
        : null;
    const checkOnlyDebugDates = Array.isArray(options.checkOnlyDebugDates) ? options.checkOnlyDebugDates : [];
    const submitInvoice = options.submitInvoice !== false;
    const dateClampMode = options.dateClampMode === 'client_created' ? 'client_created' : 'auth';
    const skipProduce = options.skipProduce === true;
    const skipFood = options.skipFood === true;

    const emitSlotStatus = (stage, clientName = '') => {
        emitEvent('slotStatus', { slotIndex, slotLabel, clientName, stage });
    };

    const queueForUi = options.sessionQueue || fullRequests;
    const sessionSelectedIds = Array.isArray(options.sessionSelectedIds)
        ? options.sessionSelectedIds.map(String)
        : [];

    let currentClient = null;

    const emitQueue = () => {
        try {
            billingSession.updateSession(source, queueForUi, { selectedIds: sessionSelectedIds });
        } catch (e) {
            console.warn('[Session] Could not save progress:', e.message);
        }
        if (currentClient) {
            console.log(`[Run] Queue update — ${currentClient.name || currentClient.id || 'client'}: ${currentClient.status || 'pending'}${currentClient.message ? ` (${currentClient.message})` : ''}`);
        }
        emitEvent('queue', queueForUi);
    };

    emitEvent('log', { message: `${slotLabel ? `[${slotLabel}] ` : ''}Processing ${toProcess.length} request(s)...` });

    // --- Browser Setup ---
    let page = options.page != null ? options.page : await getPage();

    // Helper to setup console logging on a page
    const setupPageLogging = (p) => {
        p.on('console', msg => {
            const text = msg.text();
            if (text.startsWith('[Injected]')) {
                console.log(`${slotLabel ? `[${slotLabel}] ` : ''}[Browser] ${text}`);
            } else if (msg.type() === 'error') {
                console.error(`${slotLabel ? `[${slotLabel}] ` : ''}[Browser Error] ${text}`);
            }
        });
    };
    setupPageLogging(page);

    const isLoggedIn = async () => {
        try {
            const currentUrl = page.url();
            return currentUrl.includes('uniteus.io') && !currentUrl.includes('auth');
        } catch (e) { return false; }
    };

    // --- Processing Loop ---
    for (let i = 0; i < toProcess.length; i++) {
        const req = toProcess[i];
        currentClient = req;
        if (resumeMode && sessionSelectedIds.length > 0) {
            const sid = String(req.id != null ? req.id : req.orderID || '');
            if (!sessionSelectedIds.includes(sid)) continue;
        }
        if (resumeMode && !billingSession.needsProcessing(req)) {
            continue;
        }
        req.isBrooklyn = isBrooklynAccount(apiConfig);
        if (req.isBrooklyn || req.deliveryDate != null) {
            console.log('[DATES] Request date fields:', JSON.stringify(describeReqDateFields(req)));
        }

        req.status = 'processing';
        req.message = 'Starting...';
        delete req.checkOnlyInvoiceAmounts;
        delete req.checkOnlyInvoices;
        emitQueue();
        emitSlotStatus('Starting client', req.name);
        emitEvent('log', { message: `${slotLabel ? `[${slotLabel}] ` : ''}Processing ${req.name} (${i + 1}/${toProcess.length})` });

        // API Status Tracking
        let resultSourceStatus = 'unknown';

        if (req.skip) {
            req.status = 'skipped';
            emitSlotStatus('Skipped', req.name);
            emitEvent('log', { message: 'Skipped by config.', type: 'warning' });
            emitQueue();
            continue;
        }

        // --- Base Date Calculation (endDate now; start resolved after page scrape by client type) ---
        try {
            if (!req.endDate || !ISO_DATE_RE.test(String(req.endDate))) {
                throw new Error(`Missing valid endDate (got: ${JSON.stringify(req.endDate)})`);
            }
            req.end = String(req.endDate);

            if (req.isBrooklyn) {
                const isoRe = ISO_DATE_RE;
                if (!req.deliveryDate || !isoRe.test(String(req.deliveryDate))) {
                    const diag = describeReqDateFields(req);
                    console.error('[DATES] Brooklyn client missing valid deliveryDate:', JSON.stringify(diag));
                    console.error('[DATES] Brooklyn mode is ON (account=brooklyn)');
                    req.status = 'failed';
                    emitSlotStatus('Failed', req.name);
                    emitEvent('log', {
                        message: `[DATES] Brooklyn client missing valid deliveryDate (got: ${JSON.stringify(req.deliveryDate)}). Check server console for full row dump.`,
                        type: 'error'
                    });
                    if (apiConfig) await updateOrderStatusForRequest(req, 'billing_failed', apiConfig);
                    continue;
                }
                emitEvent('log', { message: `Brooklyn billing end: ${req.end}, service date: ${req.deliveryDate}` });
            }
        } catch (e) {
            req.status = 'failed';
            emitSlotStatus('Failed', req.name);
            emitEvent('log', { message: `[MISC] Invalid date: ${e.message}`, type: 'error' });
            if (apiConfig) await updateOrderStatusForRequest(req, 'billing_failed', apiConfig);
            continue;
        }

        // --- Recursive Retry Logic (5 refreshes per session, 2 restarts per client) ---
        let restartAttempt = 0;
        const MAX_RESTARTS = 2; // Try up to 2 fresh browser sessions
        let success = false;
        let lastRefreshError = null;

        while (restartAttempt < MAX_RESTARTS && !success) {
            let refreshAttempt = 0;
            const MAX_REFRESHES = 5; // Try up to 5 refreshes per session

            while (refreshAttempt < MAX_REFRESHES && !success) {
                try {
                    // --- Login Check ---
                    if (!(await isLoggedIn())) {
                        emitSlotStatus('UniteUs login', req.name);
                        emitEvent('log', { message: `${slotLabel ? `[${slotLabel}] ` : ''}Logging in...` });
                        const authOpts = (options.page != null && options.context != null) ? { page, context: options.context } : {};
                        const loginOk = await performLoginSequence(EMAIL, PASSWORD, authOpts);
                        if (!loginOk) {
                            throw new Error('[AUTH] Login failed');
                        }
                        await sleep(2000);
                        emitSlotStatus('Session ready', req.name);
                    } else {
                        emitSlotStatus('Already signed in', req.name);
                    }

                    // --- Navigation and Refinement ---
                    if (!req.url) {
                        req.status = 'failed';
                        emitSlotStatus('Failed', req.name);
                        emitEvent('log', { message: '[NAV] Missing URL', type: 'error' });
                        if (apiConfig) await updateOrderStatusForRequest(req, 'billing_failed', apiConfig);
                        success = true; // Break loop
                        break;
                    }

                    const attemptLabel = `(S${restartAttempt + 1}/R${refreshAttempt + 1})`;
                    emitSlotStatus(`Open client URL ${attemptLabel}`, req.name);
                    emitEvent('log', { message: `Navigating to ${req.url} ${attemptLabel}...` });
                    await navigateToClientCasePage(page, req.url);
                    await sleep(3000);

                    emitSlotStatus('Read auth table & limits', req.name);
                    // Scrape Auth Info for Clamping (wait for table like injected billing, then retry if cells still empty)
                    const authInfo = await fetchAuthDetailsFromPageWhenReady(page);
                    emitEvent('log', { message: `${slotLabel ? `[${slotLabel}] ` : ''}[Auth] Scraped from page: authorizedDates="${authInfo.authorizedDates || '—'}", dateOpened="${authInfo.dateOpened || '—'}", authorizedAmount="${authInfo.authorizedAmount || '—'}", serviceType="${authInfo.serviceType || '—'}"` });

                    const isProduceClient = isProduceServiceType(authInfo.serviceType);
                    const billingStart = resolveBillingStartIso(req, isProduceClient);
                    if (!billingStart) {
                        const field = isProduceClient ? 'date' : 'startDate';
                        throw new Error(`[DATES] Missing valid ${field} for ${isProduceClient ? 'produce' : 'meal'} client`);
                    }
                    req.start = billingStart;
                    emitEvent('log', {
                        message: `${slotLabel ? `[${slotLabel}] ` : ''}Billing range: ${req.start} → ${req.end} (${isProduceClient ? 'produce: date + endDate' : 'meal: startDate + endDate'})`,
                        type: 'info'
                    });

                    if (!checkOnlyMode && (skipProduce || skipFood)) {
                        if (skipProduce && isProduceClient) {
                            req.status = 'skipped';
                            req.message = 'Skipped: Produce client (Skip produce is on)';
                            emitSlotStatus('Skipped', req.name);
                            emitEvent('log', {
                                message: `${slotLabel ? `[${slotLabel}] ` : ''}⚠️ ${req.name}: Skipped — Service Type "${authInfo.serviceType || '—'}" is Produce.`,
                                type: 'warning'
                            });
                            resultSourceStatus = 'skipped_produce';
                            success = true;
                            break;
                        }
                        if (skipFood && !isProduceClient) {
                            req.status = 'skipped';
                            req.message = 'Skipped: Food/MTM client (Skip food is on)';
                            emitSlotStatus('Skipped', req.name);
                            emitEvent('log', {
                                message: `${slotLabel ? `[${slotLabel}] ` : ''}⚠️ ${req.name}: Skipped — Service Type "${authInfo.serviceType || '—'}" is food/MTM (not Produce).`,
                                type: 'warning'
                            });
                            resultSourceStatus = 'skipped_food';
                            success = true;
                            break;
                        }
                    }

                    if (!checkOnlyMode) {
                        const apiAmount = resolveApiBillingAmount(req, isProduceClient);
                        if (apiAmount != null) {
                            req.amount = apiAmount;
                            emitEvent('log', {
                                message: `${slotLabel ? `[${slotLabel}] ` : ''}Amount from API: $${req.amount} (${isProduceClient ? 'produceAmount' : 'mealAmount'})`,
                                type: 'info'
                            });
                        }
                    }

                    // Clamping Logic
                    const parseMDY = (s) => {
                        const match = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
                        if (!match) return null;
                        return new Date(Date.UTC(+match[3], +match[1] - 1, +match[2]));
                    };

                    const dateOpened = parseMDY(authInfo.dateOpened);

                    if (!checkOnlyMode && dateClampMode === 'client_created') {
                        const cc = evaluateClientCreatedClampRules(req, authInfo, dateOpened);
                        if (cc.action === 'fail') {
                            throw cc.error;
                        }
                        if (cc.action === 'skip') {
                            req.status = 'skipped';
                            req.message = cc.message;
                            emitSlotStatus('Skipped', req.name);
                            emitEvent('log', {
                                message: `${slotLabel ? `[${slotLabel}] ` : ''}⚠️ ${req.name}: ${cc.message}`,
                                type: 'warning'
                            });
                            resultSourceStatus = 'skipped_client_created';
                            success = true;
                            break;
                        }
                    }

                    if (req.isBrooklyn) {
                        emitSlotStatus('Clamp delivery date to Date Opened', req.name);
                        const toISO = (d) => d.toISOString().split('T')[0];
                        let delivery = new Date(req.deliveryDate + 'T00:00:00Z');

                        if (dateOpened && delivery < dateOpened) {
                            emitEvent('log', { message: `[Clamping] Delivery date ${req.deliveryDate} is before Date Opened ${authInfo.dateOpened}. Adjusting...` });
                            delivery = dateOpened;
                        }
                        if (dateOpened && delivery < dateOpened) {
                            const error = new Error(`[LIMITS] Delivery date ${req.deliveryDate} is before Date Opened (${authInfo.dateOpened || 'N/A'})`);
                            error.code = 'NO_OVERLAP';
                            throw error;
                        }

                        req.deliveryDate = toISO(delivery);
                        emitEvent('log', { message: `Brooklyn service date (delivery): ${req.deliveryDate}` });
                    } else if (dateOpened) {
                        // Start only: API already sets end date. Do not clamp to Auth End.
                        emitSlotStatus('Clamp start to Date Opened', req.name);
                        const currentStart = new Date(req.start + 'T00:00:00Z');
                        const currentEnd = new Date(req.end + 'T00:00:00Z');
                        let finalStart = currentStart;
                        const finalEnd = currentEnd;

                        if (currentStart < dateOpened) {
                            emitEvent('log', { message: `[Clamping] Start date ${req.start} is before Date Opened ${authInfo.dateOpened}. Adjusting...` });
                            finalStart = dateOpened;
                        }

                        if (finalEnd < finalStart) {
                            const toISO = (d) => d.toISOString().split('T')[0];
                            const reqRange = `${req.start} to ${req.end}`;
                            const error = new Error(`[LIMITS] No overlap: Requested (${reqRange}) is before Date Opened (${authInfo.dateOpened || 'N/A'})`);
                            error.code = 'NO_OVERLAP';
                            throw error;
                        }

                        const toISO = (d) => d.toISOString().split('T')[0];
                        const prevStart = req.start;
                        const prevEnd = req.end;
                        req.start = toISO(finalStart);
                        req.end = toISO(finalEnd);

                        const diffDays = Math.floor((finalEnd - finalStart) / (1000 * 60 * 60 * 24)) + 1;
                        emitEvent('log', { message: `Final adjusted range: ${req.start} to ${req.end} (${diffDays} days)` });

                        // Food only: reduce weekly amount by (amount/7) per day clamped off (start side)
                        if (!isProduceClient) {
                            const baseAmount =
                                (typeof req.amount === 'number' && Number.isFinite(req.amount) && req.amount > 0)
                                    ? req.amount
                                    : resolveApiBillingAmount(req, false);
                            const adj = clampFoodAmountForRemovedDays(
                                baseAmount,
                                currentStart,
                                currentEnd,
                                finalStart,
                                finalEnd
                            );
                            if (adj) {
                                if (!(adj.amount > 0)) {
                                    const error = new Error(
                                        `[LIMITS] Amount clamped to $${adj.amount} after removing ${adj.daysRemoved} day(s) from ${prevStart}–${prevEnd} (daily $${adj.dailyRate.toFixed(2)})`
                                    );
                                    error.code = 'NO_OVERLAP';
                                    throw error;
                                }
                                const before = baseAmount;
                                req.amount = adj.amount;
                                if (req.mealAmount != null && req.mealAmount !== '') {
                                    req.mealAmount = adj.amount;
                                }
                                emitEvent('log', {
                                    message: `[Clamping] Food amount $${before} → $${adj.amount} (−${adj.daysRemoved} day(s) × $${adj.dailyRate.toFixed(2)}/day)`,
                                    type: 'info'
                                });
                            }
                        }
                    }

                    // --- Check-only mode: count existing billing records (no submit) ---
                    if (checkOnlyMode) {
                        emitSlotStatus('Check existing billing records', req.name);
                        const checkRange = resolveCheckOnlyRangeIso(req);
                        const countReq =
                            checkOnlyDebugDates.length > 0
                                ? { ...req, checkOnlyStarts: checkOnlyDebugDates }
                                : { ...req, start: checkRange.start, end: checkRange.end };
                        const { results, scanMeta, pageCardStarts, matchedInvoices } =
                            await countExistingBillingRecordsOnPage(page, countReq);
                        const checkDate =
                            Array.isArray(countReq.checkOnlyStarts) && countReq.checkOnlyStarts.length > 0
                                ? countReq.checkOnlyStarts.join(', ')
                                : checkRange.start && checkRange.end && checkRange.end !== checkRange.start
                                  ? `${checkRange.start}–${checkRange.end}`
                                  : checkRange.start || '—';
                        emitEvent('log', {
                            message: `${slotLabel ? `[${slotLabel}] ` : ''}[Check-only] Counting cards with start in ${checkDate} | page cards=${scanMeta?.cards ?? '?'} (dated=${scanMeta?.dated ?? '?'}, cost=${scanMeta?.cost ?? '?'})${formatPageCardStartsHint(pageCardStarts, 8)}`,
                            type: scanMeta?.cards > 0 ? 'info' : 'warning'
                        });
                        req.status = 'success';
                        req.checkOnlyPageCardCount = Number(scanMeta?.cards) || 0;
                        req.checkOnlyInvoices = Array.isArray(matchedInvoices) ? matchedInvoices : [];
                        req.checkOnlyInvoiceAmounts = formatCheckOnlyBillAmounts(req.checkOnlyInvoices, results);
                        req.message = formatCheckOnlyStatusMessage(
                            results || [],
                            scanMeta,
                            pageCardStarts,
                            checkOnlyDebugDates
                        );
                        emitEvent('log', { message: `${slotLabel ? `[${slotLabel}] ` : ''}${req.name}: ${req.message}`, type: 'success' });
                        emitQueue();
                        resultSourceStatus = 'checked_only';
                        success = true;
                        break;
                    }

                    // --- Proof: client invoice PDF (Node fetch → data URL) or generated attestation; optional ---
                    if (req.isBrooklyn) {
                        req.proofURL = null;
                        emitEvent('log', { message: `${slotLabel ? `[${slotLabel}] ` : ''}Skipping proof upload (Brooklyn).`, type: 'info' });
                    } else if (!uploadAttestations) {
                        req.proofURL = null;
                        if (req.proofURLs) req.proofURLs = [];
                        emitEvent('log', { message: `${slotLabel ? `[${slotLabel}] ` : ''}Skipping attestations/proofs (disabled).`, type: 'info' });
                    } else if (wantsClientInvoicePdf(req, customInvoicesMode, customInvoiceParams)) {
                        emitSlotStatus('Download invoice PDF', req.name);
                        const { dataUrl } = await loadClientInvoiceProofAsDataUrl(
                            req, authInfo, apiConfig, emitEvent, slotLabel, customInvoicesMode, customInvoiceParams
                        );
                        req.proofURL = dataUrl;
                        const cleanName = (req.name || 'Client').replace(/\s+/g, ' ').trim().replace(/[\\/:*?"<>|]/g, '');
                        const toDashMDY = (iso) => {
                            if (!iso || typeof iso !== 'string') return '';
                            const p = iso.split('-');
                            return p.length === 3 ? `${p[1]}-${p[2]}-${p[0]}` : iso;
                        };
                        req.fileName = `${cleanName} invoice ${toDashMDY(req.start)}-${toDashMDY(req.end)}.pdf`;
                        emitEvent('log', { message: `${slotLabel ? `[${slotLabel}] ` : ''}Invoice PDF ready for upload: ${req.fileName}`, type: 'success' });
                    } else if (!req.proofURL) {
                        emitSlotStatus('Build proof / attestation PDF', req.name);
                        const clientDetails = await fetchClientDetailsFromPage(page);
                        req.proofURL = await generateProofUrl(clientDetails, req, apiConfig);

                        const cleanName = (clientDetails.name || req.name || "Attestation")
                            .replace(/\s+/g, " ").trim()
                            .replace(/[\\/:*?"<>|]/g, "");
                        const toDashMDY = (iso) => {
                            const [y, m, d] = iso.split('-');
                            return `${m}-${d}-${y}`;
                        };
                        req.fileName = `${cleanName} ${toDashMDY(req.start)} - ${toDashMDY(req.end)}.pdf`;
                        emitEvent('log', { message: `Generated proof URL: ${req.fileName}` });
                    }

                    emitSlotStatus(
                        submitInvoice ? 'Fill billing form & submit' : 'Fill billing form (submit off — click Continue bar)',
                        req.name
                    );
                    const result = await executeBillingOnPage(page, req, { submitInvoice });
                    if (result.ok && typeof result.amount === 'number' && Number.isFinite(result.amount)) {
                        req.amount = result.amount;
                    }

                    // --- Handle Result ---
                    if (result.ok) {
                        if (result.submitSkipped) {
                            req.status = 'success';
                            req.message = 'Test: form filled; submit skipped (click Continue bar)';
                            emitSlotStatus('Success', req.name);
                            emitEvent('log', {
                                message: `${slotLabel ? `[${slotLabel}] ` : ''}Submit skipped — click the Continue bar in the browser when ready.`,
                                type: 'info'
                            });
                            resultSourceStatus = 'submit_skipped';
                        } else if (result.verified) {
                            req.status = 'success';
                            req.message = `Billed: $${result.amount || req.amount}`;
                            emitSlotStatus('Success', req.name);
                            emitEvent('log', { message: `✅ Success!`, type: 'success' });
                            resultSourceStatus = 'billing_successful';
                        } else {
                            req.status = 'warning';
                            req.message = 'Submitted but verification failed';
                            emitSlotStatus('Success', req.name);
                            emitEvent('log', { message: `⚠️ Submitted, unverified.`, type: 'warning' });
                            resultSourceStatus = 'billing_successful';
                        }
                    } else {
                        if (result.duplicate) {
                            req.status = 'skipped';
                            req.message = 'Duplicate';
                            emitSlotStatus('Skipped', req.name);
                            emitEvent('log', { message: `⏭️ Duplicate found.`, type: 'info' });
                            resultSourceStatus = 'billing_already_exists';
                            success = true; // Definitive result
                        } else {
                            // UI Error (e.g. [SHELF], [UPLOAD], etc.)
                            // Throwing here triggers the catch block below for refresh/restart retries
                            throw new Error(result.error || 'Unknown UI Error');
                        }
                    }

                    success = true; // Exit loops on definitive result

                } catch (e) {
                    const shouldSkip = e.code === 'NO_ATTESTATION_FILE' ||
                        e.code === 'NO_SIGNATURE' ||
                        e.code === 'VALIDATION_ERROR' ||
                        e.code === 'NO_OVERLAP' ||
                        e.code === 'CREATED_AT_INVALID' ||
                        e.code === 'CREATED_BEFORE_CASE_OPEN' ||
                        e.code === 'INVOICE_PDF_FETCH_FAILED' ||
                        (e.message && (e.message.includes('[LIMITS]') || e.message.includes('[CONFIG]')));

                    if (shouldSkip) {
                        req.status = 'failed';
                        req.message = e.message;
                        emitSlotStatus('Failed', req.name);
                        emitEvent('log', { message: `❌ Skip Client: ${e.message}`, type: 'error' });
                        resultSourceStatus = 'billing_failed';
                        if (apiConfig) await updateOrderStatusForRequest(req, 'billing_failed', apiConfig);
                        success = true; // Break both loops
                        break;
                    }

                    refreshAttempt++;
                    if (refreshAttempt >= MAX_REFRESHES) {
                        emitEvent('log', { message: `Refresh limit reached (${MAX_REFRESHES}).`, type: 'warning' });
                        break; // Fall through to restart logic
                    }
                    lastRefreshError = e.message;
                    const { step, type, details } = parseBillingError(e.message);
                    emitSlotStatus(`Retry: refresh ${refreshAttempt} (${step})`, req.name);
                    emitEvent('log', { message: `Refresh attempt ${refreshAttempt} failed | Step: ${step} | Type: ${type} | ${details}`, type: 'warning' });
                    await page.reload({ waitUntil: 'networkidle' }).catch(() => { });
                    await sleep(2000);
                }
            }

            if (!success) {
                restartAttempt++;
                const { step, type } = parseBillingError(lastRefreshError || '');
                if (restartAttempt < MAX_RESTARTS) {
                    emitSlotStatus(`New browser session ${restartAttempt + 1}/${MAX_RESTARTS}`, req.name);
                    emitEvent('log', { message: `${slotLabel ? `[${slotLabel}] ` : ''}Session failed (last failure: Step: ${step}, Type: ${type}). Restarting browser (Attempt ${restartAttempt + 1}/${MAX_RESTARTS})...`, type: 'warning' });
                    page = options.getPageOrRestart ? await options.getPageOrRestart() : await restartBrowser();
                    setupPageLogging(page);
                } else {
                    req.status = 'failed';
                    req.message = '[TIMEOUT] All retry attempts failed';
                    emitSlotStatus('Failed', req.name);
                    emitEvent('log', { message: `❌ ${slotLabel ? `[${slotLabel}] ` : ''}[TIMEOUT] Final attempt failed after ${MAX_RESTARTS} browser sessions.`, type: 'error' });
                    await page.screenshot({ path: `error_${slotLabel.replace(/\s/g, '-')}_${i}_final.png` }).catch(() => {});
                }
            }
        }

        // --- API Update: mark all orders for this client (orderNumbers from /api/bill or legacy orderNumber) ---
        const statusToSend = resultSourceStatus === 'billing_already_exists' ? 'billing_successful' : resultSourceStatus;
        if (!checkOnlyMode && apiConfig && (statusToSend === 'billing_successful' || statusToSend === 'billing_failed')) {
            await updateOrderStatusForRequest(req, statusToSend, apiConfig);
        }

        billingSession.clearEphemeralFromRequest(req);
        emitQueue();
        await sleep(1000);
    }

    emitSlotStatus('Idle', '');
    emitEvent('log', { message: `${slotLabel ? `[${slotLabel}] ` : ''}Billing cycle completed.` });
}

module.exports = {
    billingWorker,
    fetchRequestsFromApi,
    extractDeliveryDateFromRow,
    logDeliveryDateQueueStats,
    isBrooklynAccount
};
