/**
 * Mirrors console (log/info/warn/error) to server.log beside .env / billing_requests.json.
 * Keeps the last 3 days of lines.
 */
const fs = require('fs');
const path = require('path');
const util = require('util');

const RETENTION_DAYS = 3;
const TRIM_INTERVAL_MS = 6 * 60 * 60 * 1000;

function getAppDataDir() {
    const billingPath = process.env.BILLING_REQUESTS_PATH || path.join(__dirname, '..', '..', 'billing_requests.json');
    return path.dirname(billingPath);
}

function getLogPath() {
    return path.join(getAppDataDir(), 'server.log');
}

const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/;

function parseLineTime(line) {
    const m = line.match(TIMESTAMP_RE);
    if (!m) return null;
    const t = Date.parse(m[1]);
    return Number.isNaN(t) ? null : t;
}

function trimToRetention() {
    const logFile = getLogPath();
    try {
        if (!fs.existsSync(logFile)) return;
        const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
        const content = fs.readFileSync(logFile, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        const kept = lines.filter((line) => {
            const t = parseLineTime(line);
            return t === null || t >= cutoff;
        });
        if (kept.length < lines.length) {
            fs.writeFileSync(logFile, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
        }
    } catch (e) {
        if (process.stdout && process.stdout.write) {
            process.stdout.write(util.format('[Logger] Trim failed:', e.message) + '\n');
        }
    }
}

function formatMessage(level, args) {
    const ts = new Date().toISOString();
    const text = args.map((a) =>
        typeof a === 'string' ? a : util.inspect(a, { depth: 4, colors: false })
    ).join(' ');
    return `${ts} [${level}] ${text}\n`;
}

let stream = null;
let trimTimer = null;

function writeToFile(level, args) {
    if (!stream) return;
    try {
        stream.write(formatMessage(level, args));
    } catch (_) { /* ignore */ }
}

function install() {
    if (stream) return;

    const logFile = getLogPath();
    try {
        const dir = path.dirname(logFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        trimToRetention();
        stream = fs.createWriteStream(logFile, { flags: 'a', encoding: 'utf8' });
    } catch (e) {
        if (process.stdout && process.stdout.write) {
            process.stdout.write(util.format('[Logger] Could not create log file:', e.message) + '\n');
        }
        return;
    }

    const origLog = console.log;
    const origInfo = console.info;
    const origWarn = console.warn;
    const origError = console.error;

    console.log = function (...args) {
        writeToFile('log', args);
        origLog.apply(console, args);
    };
    console.info = function (...args) {
        writeToFile('info', args);
        origInfo.apply(console, args);
    };
    console.warn = function (...args) {
        writeToFile('warn', args);
        origWarn.apply(console, args);
    };
    console.error = function (...args) {
        writeToFile('error', args);
        origError.apply(console, args);
    };

    trimTimer = setInterval(trimToRetention, TRIM_INTERVAL_MS);
    if (trimTimer.unref) trimTimer.unref();
}

function installCrashHandlers() {
    const logCrash = (label, err) => {
        const msg = err && err.stack ? err.stack : String(err);
        console.error(`[CRASH] ${label}:`, msg);
    };
    process.on('uncaughtException', (err) => logCrash('uncaughtException', err));
    process.on('unhandledRejection', (reason) => logCrash('unhandledRejection', reason));
}

module.exports = { install, installCrashHandlers, getLogPath, trimToRetention };
