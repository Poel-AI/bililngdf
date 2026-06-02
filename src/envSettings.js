const fs = require('fs');
const path = require('path');

const DEFAULT_CONCURRENT = 10;
const DEFAULT_HEADLESS = true;
const DEFAULT_UPLOAD_ATTESTATIONS = true;
const DEFAULT_CHECK_ONLY_MODE = false;
const DEFAULT_CHECK_ONLY_MULTI_DATE_DEBUG = false;
const DEFAULT_CHECK_ONLY_DEBUG_DATES = '';
const DEFAULT_SUBMIT_INVOICE = true;
/** auth = clamp to scraped auth window only; client_created = created-at + case-open vs billing week rules */
const DEFAULT_DATE_CLAMP_MODE = 'auth';
const VALID_DATE_CLAMP_MODES = new Set(['auth', 'client_created']);
/** When true (default), "Download client list" uses GET /api/bill/invoices?date=… instead of /api/bill. */
const DEFAULT_BILL_FROM_INVOICES = true;
const MIN_CONCURRENT = 1;
const MAX_CONCURRENT = 50;

function getEnvFilePath() {
    return process.env.DOTENV_PATH || path.join(__dirname, '..', '.env');
}

function parseEnvLine(key, content) {
    const re = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'mi');
    const m = content.match(re);
    if (!m) return null;
    return m[1].replace(/^["']|["']$/g, '').trim();
}

function readSettings() {
    const envFilePath = getEnvFilePath();
    const envDir = path.dirname(envFilePath);
    let concurrentBrowsers = DEFAULT_CONCURRENT;
    let headless = DEFAULT_HEADLESS;
    let uploadAttestations = DEFAULT_UPLOAD_ATTESTATIONS;
    let checkOnlyMode = DEFAULT_CHECK_ONLY_MODE;
    let checkOnlyMultiDateDebug = DEFAULT_CHECK_ONLY_MULTI_DATE_DEBUG;
    let checkOnlyDebugDates = DEFAULT_CHECK_ONLY_DEBUG_DATES;
    let submitInvoice = DEFAULT_SUBMIT_INVOICE;
    let dateClampMode = DEFAULT_DATE_CLAMP_MODE;
    let billFromInvoices = DEFAULT_BILL_FROM_INVOICES;

    let fromFile = false;
    if (fs.existsSync(envFilePath)) {
        let content;
        try {
            content = fs.readFileSync(envFilePath, 'utf8');
        } catch (e) {
            console.warn(
                `[Settings] Cannot read ${envFilePath} (${e.code || e.message}). Using defaults and process.env.`
            );
            content = null;
        }
        if (content != null) {
            fromFile = true;
            const c = parseEnvLine('CONCURRENT_BROWSERS', content);
            if (c != null && c !== '') {
                const n = parseInt(c, 10);
                if (Number.isFinite(n)) concurrentBrowsers = Math.min(MAX_CONCURRENT, Math.max(MIN_CONCURRENT, n));
            }
            const h = parseEnvLine('HEADLESS', content);
            if (h != null && h !== '') {
                headless = /^true$/i.test(h);
            }
            const u = parseEnvLine('UPLOAD_ATTESTATIONS', content);
            if (u != null && u !== '') {
                uploadAttestations = /^true$/i.test(u);
            }
            const m = parseEnvLine('CHECK_ONLY_MODE', content);
            if (m != null && m !== '') {
                checkOnlyMode = /^true$/i.test(m);
            }
            const mdd = parseEnvLine('CHECK_ONLY_MULTI_DATE_DEBUG', content);
            if (mdd != null && mdd !== '') {
                checkOnlyMultiDateDebug = /^true$/i.test(mdd);
            }
            const codd = parseEnvLine('CHECK_ONLY_DEBUG_DATES', content);
            if (codd != null) {
                checkOnlyDebugDates = codd;
            }
            const si = parseEnvLine('SUBMIT_INVOICE', content);
            if (si != null && si !== '') {
                submitInvoice = /^true$/i.test(si);
            }
            const dcm = parseEnvLine('DATE_CLAMP_MODE', content);
            if (dcm != null && dcm !== '' && VALID_DATE_CLAMP_MODES.has(String(dcm).toLowerCase())) {
                dateClampMode = String(dcm).toLowerCase();
            }
            const bfi = parseEnvLine('BILL_FROM_INVOICES', content);
            if (bfi != null && bfi !== '') {
                billFromInvoices = /^true$/i.test(bfi);
            }
        }
    }
    if (!fromFile) {
        const fromProc = parseInt(process.env.CONCURRENT_BROWSERS, 10);
        if (Number.isFinite(fromProc)) {
            concurrentBrowsers = Math.min(MAX_CONCURRENT, Math.max(MIN_CONCURRENT, fromProc));
        }
        if (process.env.HEADLESS != null && process.env.HEADLESS !== '') {
            headless = /^true$/i.test(String(process.env.HEADLESS));
        }
        if (process.env.UPLOAD_ATTESTATIONS != null && process.env.UPLOAD_ATTESTATIONS !== '') {
            uploadAttestations = /^true$/i.test(String(process.env.UPLOAD_ATTESTATIONS));
        }
        if (process.env.CHECK_ONLY_MODE != null && process.env.CHECK_ONLY_MODE !== '') {
            checkOnlyMode = /^true$/i.test(String(process.env.CHECK_ONLY_MODE));
        }
        if (process.env.CHECK_ONLY_MULTI_DATE_DEBUG != null && process.env.CHECK_ONLY_MULTI_DATE_DEBUG !== '') {
            checkOnlyMultiDateDebug = /^true$/i.test(String(process.env.CHECK_ONLY_MULTI_DATE_DEBUG));
        }
        if (process.env.CHECK_ONLY_DEBUG_DATES != null) {
            checkOnlyDebugDates = String(process.env.CHECK_ONLY_DEBUG_DATES);
        }
        if (process.env.SUBMIT_INVOICE != null && process.env.SUBMIT_INVOICE !== '') {
            submitInvoice = /^true$/i.test(String(process.env.SUBMIT_INVOICE));
        }
        if (process.env.DATE_CLAMP_MODE != null && process.env.DATE_CLAMP_MODE !== '') {
            const v = String(process.env.DATE_CLAMP_MODE).toLowerCase();
            if (VALID_DATE_CLAMP_MODES.has(v)) dateClampMode = v;
        }
        if (process.env.BILL_FROM_INVOICES != null && process.env.BILL_FROM_INVOICES !== '') {
            billFromInvoices = /^true$/i.test(String(process.env.BILL_FROM_INVOICES));
        }
    }

    return {
        concurrentBrowsers,
        headless,
        uploadAttestations,
        checkOnlyMode,
        checkOnlyMultiDateDebug,
        checkOnlyDebugDates,
        submitInvoice,
        dateClampMode,
        billFromInvoices,
        envFilePath,
        envDir
    };
}

function applyToProcessEnv(concurrentBrowsers, headless, uploadAttestations, checkOnlyMode) {
    process.env.CONCURRENT_BROWSERS = String(concurrentBrowsers);
    process.env.HEADLESS = headless ? 'true' : 'false';
    process.env.UPLOAD_ATTESTATIONS = uploadAttestations ? 'true' : 'false';
    process.env.CHECK_ONLY_MODE = checkOnlyMode ? 'true' : 'false';
}

/**
 * Update CONCURRENT_BROWSERS and/or HEADLESS in the .env file.
 * Preserves other lines; replaces existing keys or appends at end.
 * Only keys present on `updates` are written.
 */
function writeSettings(updates) {
    if (
        updates.concurrentBrowsers == null &&
        updates.headless == null &&
        updates.uploadAttestations == null &&
        updates.checkOnlyMode == null &&
        updates.checkOnlyMultiDateDebug == null &&
        updates.checkOnlyDebugDates == null &&
        updates.submitInvoice == null &&
        updates.dateClampMode == null &&
        updates.billFromInvoices == null
    ) {
        throw new Error('No settings to update');
    }

    const envFilePath = getEnvFilePath();
    const envDir = path.dirname(envFilePath);
    if (!fs.existsSync(envDir)) {
        fs.mkdirSync(envDir, { recursive: true });
    }

    const current = readSettings();
    const nextConcurrent =
        updates.concurrentBrowsers != null
            ? Math.min(MAX_CONCURRENT, Math.max(MIN_CONCURRENT, parseInt(updates.concurrentBrowsers, 10) || MIN_CONCURRENT))
            : current.concurrentBrowsers;
    const nextHeadless = updates.headless != null ? Boolean(updates.headless) : current.headless;
    const nextUploadAttestations =
        updates.uploadAttestations != null ? Boolean(updates.uploadAttestations) : current.uploadAttestations;
    const nextCheckOnlyMode =
        updates.checkOnlyMode != null ? Boolean(updates.checkOnlyMode) : current.checkOnlyMode;
    const nextCheckOnlyMultiDateDebug =
        updates.checkOnlyMultiDateDebug != null
            ? Boolean(updates.checkOnlyMultiDateDebug)
            : current.checkOnlyMultiDateDebug;
    const nextCheckOnlyDebugDates =
        updates.checkOnlyDebugDates != null ? String(updates.checkOnlyDebugDates) : current.checkOnlyDebugDates;
    const nextSubmitInvoice =
        updates.submitInvoice != null ? Boolean(updates.submitInvoice) : current.submitInvoice;
    let nextDateClampMode = current.dateClampMode;
    if (updates.dateClampMode != null) {
        const v = String(updates.dateClampMode).toLowerCase();
        nextDateClampMode = VALID_DATE_CLAMP_MODES.has(v) ? v : current.dateClampMode;
    }
    const nextBillFromInvoices =
        updates.billFromInvoices != null ? Boolean(updates.billFromInvoices) : current.billFromInvoices;

    let lines = [];
    if (fs.existsSync(envFilePath)) {
        try {
            lines = fs.readFileSync(envFilePath, 'utf8').split(/\r?\n/);
        } catch (e) {
            const hint =
                e.code === 'EPERM' || e.code === 'EACCES'
                    ? 'Close other programs using this file, clear Read-only on .env, or unblock the folder (Windows Properties → Security / Unblock).'
                    : e.message;
            throw new Error(`Cannot read .env (${e.code || ''}): ${hint}`);
        }
    }

    const setKey = (key, value) => {
        const esc = String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
        const newLine = `${key}=${esc}`;
        const keyRe = new RegExp(`^\\s*${key}\\s*=`);
        let found = false;
        for (let i = 0; i < lines.length; i++) {
            if (keyRe.test(lines[i])) {
                lines[i] = newLine;
                found = true;
                break;
            }
        }
        if (!found) {
            if (lines.length && lines[lines.length - 1] !== '') lines.push('');
            lines.push(newLine);
        }
    };

    if (updates.concurrentBrowsers != null) {
        setKey('CONCURRENT_BROWSERS', String(nextConcurrent));
    }
    if (updates.headless != null) {
        setKey('HEADLESS', nextHeadless ? 'true' : 'false');
    }
    if (updates.uploadAttestations != null) {
        setKey('UPLOAD_ATTESTATIONS', nextUploadAttestations ? 'true' : 'false');
    }
    if (updates.checkOnlyMode != null) {
        setKey('CHECK_ONLY_MODE', nextCheckOnlyMode ? 'true' : 'false');
    }
    if (updates.checkOnlyMultiDateDebug != null) {
        setKey('CHECK_ONLY_MULTI_DATE_DEBUG', nextCheckOnlyMultiDateDebug ? 'true' : 'false');
    }
    if (updates.checkOnlyDebugDates != null) {
        setKey('CHECK_ONLY_DEBUG_DATES', nextCheckOnlyDebugDates);
    }
    if (updates.submitInvoice != null) {
        setKey('SUBMIT_INVOICE', nextSubmitInvoice ? 'true' : 'false');
    }
    if (updates.dateClampMode != null) {
        setKey('DATE_CLAMP_MODE', nextDateClampMode);
    }
    if (updates.billFromInvoices != null) {
        setKey('BILL_FROM_INVOICES', nextBillFromInvoices ? 'true' : 'false');
    }

    const body = lines.join('\n').replace(/\n+$/, '') + '\n';
    try {
        fs.writeFileSync(envFilePath, body, 'utf8');
    } catch (e) {
        const hint =
            e.code === 'EPERM' || e.code === 'EACCES'
                ? 'Cannot write .env (permission denied). Move the project out of Downloads, run the app as a user who owns the folder, or edit .env manually.'
                : e.message;
        throw new Error(`Cannot save settings (${e.code || ''}): ${hint}`);
    }

    applyToProcessEnv(nextConcurrent, nextHeadless, nextUploadAttestations, nextCheckOnlyMode);

    if (updates.checkOnlyMultiDateDebug != null) {
        process.env.CHECK_ONLY_MULTI_DATE_DEBUG = nextCheckOnlyMultiDateDebug ? 'true' : 'false';
    }
    if (updates.checkOnlyDebugDates != null) {
        process.env.CHECK_ONLY_DEBUG_DATES = nextCheckOnlyDebugDates;
    }
    if (updates.submitInvoice != null) {
        process.env.SUBMIT_INVOICE = nextSubmitInvoice ? 'true' : 'false';
    }
    if (updates.dateClampMode != null) {
        process.env.DATE_CLAMP_MODE = nextDateClampMode;
    }
    if (updates.billFromInvoices != null) {
        process.env.BILL_FROM_INVOICES = nextBillFromInvoices ? 'true' : 'false';
    }

    return {
        concurrentBrowsers: nextConcurrent,
        headless: nextHeadless,
        uploadAttestations: nextUploadAttestations,
        checkOnlyMode: nextCheckOnlyMode,
        checkOnlyMultiDateDebug: nextCheckOnlyMultiDateDebug,
        checkOnlyDebugDates: nextCheckOnlyDebugDates,
        submitInvoice: nextSubmitInvoice,
        dateClampMode: nextDateClampMode,
        billFromInvoices: nextBillFromInvoices,
        envFilePath,
        envDir
    };
}

function openEnvFolder() {
    const { spawn } = require('child_process');
    const envFilePath = getEnvFilePath();
    const dir = path.dirname(envFilePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const platform = process.platform;
    if (platform === 'darwin') {
        spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref();
    } else if (platform === 'win32') {
        spawn('explorer', [dir], { detached: true, stdio: 'ignore' }).unref();
    } else {
        spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
    }
}

module.exports = {
    getEnvFilePath,
    readSettings,
    writeSettings,
    applyToProcessEnv,
    openEnvFolder,
    MIN_CONCURRENT,
    MAX_CONCURRENT,
    DEFAULT_CONCURRENT,
    DEFAULT_HEADLESS,
    DEFAULT_UPLOAD_ATTESTATIONS,
    DEFAULT_CHECK_ONLY_MODE,
    DEFAULT_CHECK_ONLY_MULTI_DATE_DEBUG,
    DEFAULT_CHECK_ONLY_DEBUG_DATES,
    DEFAULT_SUBMIT_INVOICE,
    DEFAULT_DATE_CLAMP_MODE,
    VALID_DATE_CLAMP_MODES,
    DEFAULT_BILL_FROM_INVOICES
};
