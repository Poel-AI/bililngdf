const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const envSettings = require('../envSettings');

const DEFAULT_FILENAME = 'billing-queue.xlsx';

function parseQueueAmount(val) {
    if (val == null || val === '') return null;
    if (typeof val === 'number' && Number.isFinite(val)) return val;
    const n = parseFloat(String(val).replace(/[$,]/g, ''));
    return Number.isFinite(n) ? n : null;
}

function householdPeople(r) {
    const deps = Array.isArray(r.dependants) ? r.dependants.length : 0;
    return Math.max(1, 1 + deps);
}

function buildQueueRows(queue) {
    return queue.map((r) => {
        const total = parseQueueAmount(r.amount);
        const people = householdPeople(r);
        const perPerson =
            total != null ? Math.round((total / people) * 100) / 100 : '';
        return {
            'Client name': r.name || '',
            Id: r.id != null ? String(r.id) : r.orderID != null ? String(r.orderID) : '',
            ClientId: r.clientId != null ? String(r.clientId) : '',
            Start: r.start || r.date || '',
            End: r.end || r.endDate || '',
            'Per person': perPerson,
            Status: r.status || 'pending',
            'Invoice cost (check-only)': r.checkOnlyInvoiceAmounts || '',
            Message: r.message || '',
            'Order numbers': Array.isArray(r.orderNumbers) ? r.orderNumbers.join(', ') : '',
            URL: r.url || ''
        };
    });
}

function buildQueueWorkbookBuffer(queue) {
    const rows = buildQueueRows(queue);
    const sheet = XLSX.utils.json_to_sheet(rows);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Queue');
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

function getDefaultExportPath() {
    const envDir = path.dirname(envSettings.getEnvFilePath());
    return path.join(envDir, DEFAULT_FILENAME);
}

/**
 * Write queue results to billing-queue.xlsx beside .env (overwrites each run).
 * @returns {{ ok: true, path: string } | { ok: false, error: string }}
 */
function saveQueueExcelToDisk(queue, filePath = getDefaultExportPath()) {
    if (!Array.isArray(queue) || queue.length === 0) {
        return { ok: false, error: 'Queue is empty' };
    }
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const buf = buildQueueWorkbookBuffer(queue);
        fs.writeFileSync(filePath, buf);
        return { ok: true, path: filePath };
    } catch (e) {
        return { ok: false, error: e.message || String(e) };
    }
}

function downloadFilenameStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `billing-queue-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.xlsx`;
}

module.exports = {
    DEFAULT_FILENAME,
    buildQueueRows,
    buildQueueWorkbookBuffer,
    getDefaultExportPath,
    saveQueueExcelToDisk,
    downloadFilenameStamp,
};
