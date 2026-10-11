/**
 * One automation job. Spawned by the portal with the job folder as argv[2].
 * Env is set before any app module loads so session, logs, and .env stay in that folder.
 */
const path = require('path');
const fs = require('fs');

const jobDir = process.argv[2];
if (!jobDir) {
    console.error('[Job] Missing job directory');
    process.exit(1);
}

process.env.BILLING_REQUESTS_PATH = path.join(jobDir, 'billing_requests.json');
process.env.DOTENV_PATH = path.join(jobDir, '.env');
process.env.HEADLESS = 'true';
process.env.LIVE_VIEW = '1';
process.env.PORTAL_JOB = '1';

const abort = { requested: false };

global.__onLiveFrame = (frame) => {
    if (!process.send || !frame) return;
    try {
        process.send({ channel: 'frame', slotId: frame.slotId, data: frame.data, w: frame.w, h: frame.h });
    } catch (_) { /* parent gone */ }
};

function broadcast(type, data) {
    if (type === 'log' && data && data.message) {
        const level = data.type === 'error' ? 'error' : data.type === 'warning' ? 'warn' : 'log';
        console[level](`[Run] ${data.message}`);
    }
    if (process.send) {
        try {
            process.send({ channel: 'event', event: type, data });
        } catch (_) { /* parent gone */ }
    }
}

process.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.channel === 'stop') {
        abort.requested = true;
        broadcast('log', { message: 'Stop requested — closing browsers…', type: 'warning' });
        const { closeAllBrowserInstances, closeBrowser } = require('./core/browser');
        Promise.allSettled([closeAllBrowserInstances(), closeBrowser()]).catch(() => {});
        return;
    }
    if (msg.channel === 'focus') {
        global.__liveFocusSlot = String(msg.slotId);
        return;
    }
    if (msg.channel === 'input') {
        const { handleLiveInput } = require('./core/browser');
        handleLiveInput(msg).catch(() => {});
    }
});

async function main() {
    const runPath = path.join(jobDir, 'run.json');
    const prepared = JSON.parse(fs.readFileSync(runPath, 'utf8'));
    const { executePreparedRun } = require('./core/runAutomation');
    // Job .env is loaded with override during require. Live view always stays headless on the server.
    process.env.HEADLESS = 'true';
    process.env.LIVE_VIEW = '1';
    try {
        const { install, installCrashHandlers } = require('./core/logger');
        install();
        installCrashHandlers();
    } catch (_) { /* logging still goes to the parent */ }
    broadcast('automationState', { isRunning: true });
    broadcast('log', {
        message: prepared.kind === 'insurance' ? '--- Starting Insurance Verification ---' : `--- Starting Automation Run (${prepared.billingSource || 'queue'}) ---`,
        type: 'info',
    });
    const outcome = await executePreparedRun(prepared, broadcast, abort);
    if (process.send) {
        process.send({ channel: 'done', outcome: outcome || 'failed' });
    }
    process.exit(outcome === 'failed' ? 1 : 0);
}

main().catch((e) => {
    console.error('[Job] Fatal:', e);
    broadcast('log', { message: `Critical Error: ${e.message}`, type: 'error' });
    if (process.send) {
        try { process.send({ channel: 'done', outcome: 'failed', error: e.message }); } catch (_) {}
    }
    process.exit(1);
});
