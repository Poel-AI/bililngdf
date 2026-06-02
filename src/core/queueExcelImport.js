const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

/** Statuses that count as “still need billing” when importing from Excel. */
const NEEDS_BILLING_STATUSES = new Set(['pending', 'processing', 'failed', 'stopped']);

function normalizeStatus(val) {
    return String(val || 'pending').trim().toLowerCase();
}

function cellStr(row, ...keys) {
    for (const k of keys) {
        if (row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
    }
    return '';
}

function parseExcelBuffer(buf) {
    const book = XLSX.read(buf, { type: 'buffer' });
    const sheetName = book.SheetNames[0];
    if (!sheetName) return [];
    return XLSX.utils.sheet_to_json(book.Sheets[sheetName], { defval: '' });
}

function buildLookups(queue) {
    const byId = new Map();
    const byClientId = new Map();
    const byUrl = new Map();
    for (const r of queue) {
        if (r.id != null) byId.set(String(r.id), r);
        if (r.clientId) byClientId.set(String(r.clientId).toLowerCase(), r);
        if (r.url) byUrl.set(String(r.url).trim().toLowerCase(), r);
    }
    return { byId, byClientId, byUrl };
}

function findSourceRecord(row, lookups) {
    const id = cellStr(row, 'Id', 'id');
    if (id && lookups.byId.has(id)) return lookups.byId.get(id);

    const clientId = cellStr(row, 'ClientId', 'clientId');
    if (clientId && lookups.byClientId.has(clientId.toLowerCase())) {
        return lookups.byClientId.get(clientId.toLowerCase());
    }

    const url = cellStr(row, 'URL', 'url');
    if (url && lookups.byUrl.has(url.toLowerCase())) return lookups.byUrl.get(url.toLowerCase());

    return null;
}

function rowToMinimalRequest(row) {
    const id = cellStr(row, 'Id', 'id') || undefined;
    const start = cellStr(row, 'Start', 'start', 'date');
    const end = cellStr(row, 'End', 'end', 'endDate');
    const orderNums = cellStr(row, 'Order numbers', 'orderNumbers');
    return {
        id,
        clientId: cellStr(row, 'ClientId', 'clientId') || null,
        name: cellStr(row, 'Client name', 'name'),
        url: cellStr(row, 'URL', 'url') || null,
        date: start,
        endDate: end,
        start: start || undefined,
        end: end || undefined,
        orderNumbers: orderNums
            ? orderNums.split(',').map((s) => s.trim()).filter(Boolean)
            : [],
        dependants: [],
        proofURLs: [],
        status: 'pending',
        message: 'Imported from Excel',
        useClientInvoicePdf: true,
    };
}

/**
 * @param {Buffer} buf - .xlsx file
 * @param {object[]} sourceQueue - full client rows (current queue + optional remapped download)
 * @param {{ onlyRemaining?: boolean }} opts
 */
function importQueueFromExcelBuffer(buf, sourceQueue, opts = {}) {
    const onlyRemaining = opts.onlyRemaining !== false;
    const rows = parseExcelBuffer(buf);
    if (!rows.length) {
        return { ok: false, error: 'Excel file has no data rows.' };
    }

    const excelRows = onlyRemaining
        ? rows.filter((row) => NEEDS_BILLING_STATUSES.has(normalizeStatus(row.Status ?? row.status)))
        : rows;

    if (!excelRows.length) {
        return {
            ok: false,
            error: onlyRemaining
                ? 'No rows with status pending, processing, failed, or stopped found in the Excel file.'
                : 'No rows found in the Excel file.',
        };
    }

    const lookups = buildLookups(Array.isArray(sourceQueue) ? sourceQueue : []);
    const queue = [];
    const missing = [];
    const statusCounts = {};

    for (const row of excelRows) {
        const excelStatus = normalizeStatus(row.Status ?? row.status);
        statusCounts[excelStatus] = (statusCounts[excelStatus] || 0) + 1;

        let req = findSourceRecord(row, lookups);
        if (req) {
            req = { ...req };
        } else {
            req = rowToMinimalRequest(row);
            if (!req.url && !req.clientId) {
                missing.push(cellStr(row, 'Client name', 'name') || cellStr(row, 'Id', 'id') || '(unknown row)');
                continue;
            }
        }

        req.status = 'pending';
        req.message =
            excelStatus === 'failed' || excelStatus === 'processing'
                ? `Imported from Excel (was ${excelStatus})`
                : 'Imported from Excel';
        delete req.checkOnlyInvoiceAmounts;
        delete req.proofURL;
        delete req.fileName;

        if (!req.id) {
            req.id = cellStr(row, 'Id', 'id') || `import-${queue.length + 1}`;
        }

        queue.push(req);
    }

    if (!queue.length) {
        return {
            ok: false,
            error: `Could not match any Excel rows to client data.${missing.length ? ` ${missing.length} row(s) missing URL/ClientId.` : ''}`,
            missing,
        };
    }

    return {
        ok: true,
        queue,
        imported: queue.length,
        excelRowCount: rows.length,
        filteredRowCount: excelRows.length,
        statusCounts,
        missing,
        selectedIds: queue.map((r) => String(r.id)),
    };
}

function loadDownloadedClientsJson(appDataDir, filename = 'downloaded_clients.json') {
    const p = path.join(appDataDir, filename);
    if (!fs.existsSync(p)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        return Array.isArray(data) ? data : null;
    } catch (e) {
        console.warn('[Import] Could not read downloaded_clients.json:', e.message);
        return null;
    }
}

module.exports = {
    NEEDS_BILLING_STATUSES,
    normalizeStatus,
    parseExcelBuffer,
    importQueueFromExcelBuffer,
    loadDownloadedClientsJson,
};
