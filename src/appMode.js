/**
 * App product mode — shared by Electron shell, Express API, and (via /api/settings) the UI.
 *
 * Resolution order:
 *   1. process.env.DF_APP_MODE
 *   2. src/app-mode.json  { "mode": "billing" | "insurance" }
 *   3. default "billing"
 *
 * "insurance" = insurance verification only (no billing UI / process-billing).
 */
const fs = require('fs');
const path = require('path');

const VALID = new Set(['billing', 'insurance']);

function normalizeMode(raw) {
    const m = String(raw || '').trim().toLowerCase();
    if (m === 'insurance' || m === 'insurance-only' || m === 'verify') return 'insurance';
    if (m === 'billing' || m === 'full') return 'billing';
    return null;
}

function readModeFile() {
    try {
        const p = path.join(__dirname, 'app-mode.json');
        if (!fs.existsSync(p)) return null;
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        return normalizeMode(j && j.mode);
    } catch (_) {
        return null;
    }
}

function getAppMode() {
    return normalizeMode(process.env.DF_APP_MODE) || readModeFile() || 'billing';
}

function isInsuranceOnly() {
    return getAppMode() === 'insurance';
}

function getAppDisplayName() {
    return isInsuranceOnly() ? 'Diet Fantasy Insurance' : 'Diet Fantasy Billing';
}

/** Default listen port when PORT is unset — keep insurance side-by-side with billing. */
function getDefaultPort() {
    return isInsuranceOnly() ? 3502 : 3500;
}

module.exports = {
    getAppMode,
    isInsuranceOnly,
    getAppDisplayName,
    getDefaultPort,
    VALID
};
