const CUSTOMER_API_BASE = 'https://customer.thedietfantasy.com';

function firstProofUrlRaw(req) {
    if (Array.isArray(req?.proofURLs) && req.proofURLs.length > 0 && req.proofURLs[0]) {
        return String(req.proofURLs[0]);
    }
    if (req?.proofURL) return String(req.proofURL);
    return '';
}

function invoiceUrlsForClientId(req) {
    const out = [];
    if (req?.mealInvoice) out.push(String(req.mealInvoice));
    if (req?.produceInvoice) out.push(String(req.produceInvoice));
    const legacy = firstProofUrlRaw(req);
    if (legacy) out.push(legacy);
    return out;
}

function resolveUrlForParse(raw, baseUrl = CUSTOMER_API_BASE) {
    const t = String(raw || '').trim();
    if (!t) return null;
    if (/^https?:\/\//i.test(t)) return t;
    const base = String(baseUrl || CUSTOMER_API_BASE).replace(/\/$/, '');
    return t.startsWith('/') ? `${base}${t}` : `${base}/${t}`;
}

/** Parse client-invoice-pdf query params from an API proof URL. */
function parseClientInvoicePdfUrl(raw, baseUrl = CUSTOMER_API_BASE) {
    const resolved = resolveUrlForParse(raw, baseUrl);
    if (!resolved || !/client-invoice-pdf/i.test(resolved)) return null;
    try {
        const u = new URL(resolved);
        return {
            clientId: u.searchParams.get('clientId') || null,
            from: u.searchParams.get('from') || null,
            to: u.searchParams.get('to') || null,
            itemName: u.searchParams.get('itemName') || '',
            quantity: u.searchParams.get('quantity') || '',
            unitPrice: u.searchParams.get('unitPrice') || ''
        };
    } catch {
        return null;
    }
}

function billingWeekEndIso(req) {
    if (req.endDate) return String(req.endDate);
    if (req.end) return String(req.end);
    const start = req.startDate || req.date || req.start;
    if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(String(start))) return '';
    const [y, m, d] = String(start).split('-').map(Number);
    const end = new Date(Date.UTC(y, m - 1, d));
    end.setUTCDate(end.getUTCDate() + 6);
    return end.toISOString().slice(0, 10);
}

function resolveClientIdForRequest(req, baseUrl = CUSTOMER_API_BASE) {
    if (!req || typeof req !== 'object') return '';
    for (const raw of invoiceUrlsForClientId(req)) {
        const parsed = parseClientInvoicePdfUrl(raw, baseUrl);
        if (parsed?.clientId) return String(parsed.clientId).trim();
    }
    if (req.clientId != null && String(req.clientId).trim() !== '') return String(req.clientId).trim();
    return '';
}

/** Shared toolbar fields + clientId parsed from each row's API proof link. */
function mergeCustomInvoiceForRequest(req, globalParams, baseUrl = CUSTOMER_API_BASE) {
    const g = globalParams || {};
    return {
        clientId: resolveClientIdForRequest(req, baseUrl),
        from: g.from,
        to: g.to,
        itemName: g.itemName,
        quantity: g.quantity,
        unitPrice: g.unitPrice
    };
}

function validateCustomInvoiceGlobalParams(params) {
    if (!params || typeof params !== 'object') return 'Custom invoice fields missing';
    const missing = [];
    if (!params.from || !/^\d{4}-\d{2}-\d{2}$/.test(String(params.from))) missing.push('from (YYYY-MM-DD)');
    if (!params.to || !/^\d{4}-\d{2}-\d{2}$/.test(String(params.to))) missing.push('to (YYYY-MM-DD)');
    if (params.itemName == null || String(params.itemName).trim() === '') missing.push('itemName');
    if (params.quantity == null || String(params.quantity).trim() === '') missing.push('quantity');
    if (params.unitPrice == null || String(params.unitPrice).trim() === '') missing.push('unitPrice');
    if (missing.length) return `Custom invoice missing: ${missing.join(', ')}`;
    return null;
}

function validateCustomInvoiceParams(ci) {
    const globalErr = validateCustomInvoiceGlobalParams(ci);
    if (globalErr) return globalErr;
    if (!ci.clientId || String(ci.clientId).trim() === '') return 'Custom invoice missing: clientId (from API proof link)';
    return null;
}

function buildClientInvoicePdfUrl(baseUrl, params) {
    const ci = params || {};
    const err = validateCustomInvoiceParams(ci);
    if (err) {
        const e = new Error(`[PROOF] ${err}`);
        e.code = 'CUSTOM_INVOICE_INVALID';
        throw e;
    }
    const base = String(baseUrl || CUSTOMER_API_BASE).replace(/\/$/, '');
    const u = new URL('/api/client-invoice-pdf', `${base}/`);
    u.searchParams.set('clientId', String(ci.clientId).trim());
    u.searchParams.set('from', String(ci.from).trim());
    u.searchParams.set('to', String(ci.to).trim());
    u.searchParams.set('itemName', String(ci.itemName).trim());
    u.searchParams.set('quantity', String(ci.quantity).trim());
    u.searchParams.set('unitPrice', String(ci.unitPrice).trim());
    return u.toString();
}

module.exports = {
    CUSTOMER_API_BASE,
    firstProofUrlRaw,
    parseClientInvoicePdfUrl,
    resolveClientIdForRequest,
    mergeCustomInvoiceForRequest,
    validateCustomInvoiceGlobalParams,
    validateCustomInvoiceParams,
    buildClientInvoicePdfUrl,
    billingWeekEndIso
};
