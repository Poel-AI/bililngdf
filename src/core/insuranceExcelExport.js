const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const envSettings = require('../envSettings');

const DEFAULT_FILENAME = 'insurance-verify.xlsx';

function buildInsuranceRows(queue) {
    const rows = [];
    for (const r of Array.isArray(queue) ? queue : []) {
        const base = {
            'Client name': r.name || '',
            Id: r.id != null ? String(r.id) : r.orderID != null ? String(r.orderID) : '',
            ClientId: r.clientId != null ? String(r.clientId) : '',
            'Unite link': r.url || '',
            'Contact ID': r.insuranceContactId || '',
            'Facesheet URL': r.insuranceProfileUrl || '',
            'Run status': r.status || '',
            Message: r.message || '',
        };
        const results = Array.isArray(r.insuranceResults) ? r.insuranceResults : [];
        if (results.length === 0) {
            rows.push({
                ...base,
                Plan: '',
                Status: '',
                Detail: '',
            });
            continue;
        }
        for (const inv of results) {
            rows.push({
                ...base,
                Plan: inv.plan || '',
                Status: inv.status || '',
                Detail: inv.detail || '',
            });
        }
    }
    return rows;
}

function buildInsuranceWorkbookBuffer(queue) {
    const rows = buildInsuranceRows(queue);
    const sheet = XLSX.utils.json_to_sheet(rows);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Insurance');
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

function getDefaultExportPath() {
    const envDir = path.dirname(envSettings.getEnvFilePath());
    return path.join(envDir, DEFAULT_FILENAME);
}

function saveInsuranceExcelToDisk(queue, filePath = getDefaultExportPath()) {
    if (!Array.isArray(queue) || queue.length === 0) {
        return { ok: false, error: 'Queue is empty' };
    }
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, buildInsuranceWorkbookBuffer(queue));
        return { ok: true, path: filePath };
    } catch (e) {
        return { ok: false, error: e.message || String(e) };
    }
}

function downloadFilenameStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `insurance-verify-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.xlsx`;
}

module.exports = {
    DEFAULT_FILENAME,
    buildInsuranceRows,
    buildInsuranceWorkbookBuffer,
    getDefaultExportPath,
    saveInsuranceExcelToDisk,
    downloadFilenameStamp,
};
