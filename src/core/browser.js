const { chromium } = require('playwright');
const path = require('path');
const { safeLoadDotenv } = require('../safeDotenv');

const dotenvPath = process.env.DOTENV_PATH || path.join(__dirname, '..', '..', '.env');
safeLoadDotenv(dotenvPath);

let browser = null;
let context = null;
let page = null;

/** Shared launch options for Chromium (singleton and multi-instance). */
const launchOptions = () => {
    const opts = {
        headless: process.env.HEADLESS === 'true',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-site-isolation-trials',
        ],
    };
    // Prefer installed Google Chrome when available (closer to a "real" browser / feature flags).
    if (/^(1|true|yes)$/i.test(String(process.env.USE_SYSTEM_CHROME || 'true'))) {
        opts.channel = 'chrome';
    }
    return opts;
};

function playwrightBrowserHint() {
    const p = process.env.PLAYWRIGHT_BROWSERS_PATH || '(default cache)';
    return (
        `PLAYWRIGHT_BROWSERS_PATH=${p}. ` +
        'Install Chromium: npm run install-browsers (from the project root). ' +
        'If PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 was set during npm install, run that script anyway.'
    );
}

async function launchChromium() {
    try {
        return await chromium.launch(launchOptions());
    } catch (e) {
        const msg = String(e.message || e);
        // Fall back to bundled Chromium if system Chrome channel is missing
        if (launchOptions().channel && (msg.includes('channel') || msg.includes('Executable') || msg.includes('chrome'))) {
            console.warn('[Browser] System Chrome unavailable, falling back to bundled Chromium:', msg);
            try {
                const { channel, ...rest } = launchOptions();
                return await chromium.launch(rest);
            } catch (e2) {
                throw new Error(`${e2.message}\n${playwrightBrowserHint()}`);
            }
        }
        if (msg.includes("Executable doesn't exist") || msg.includes('BrowserType.launch')) {
            throw new Error(`${msg}\n${playwrightBrowserHint()}`);
        }
        throw e;
    }
}

const contextOptions = () => ({
    // Windows Chrome-like UA (host OS is Windows) — Mac UA can change Unite feature delivery
    userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1400, height: 900 },
    permissions: [],
    geolocation: undefined,
    locale: 'en-US',
    bypassCSP: true,
    extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        DNT: '1',
        Connection: 'keep-alive',
    },
});

function shouldAbortThirdParty(url) {
    // Keep maps/intercom blocked for speed — but NEVER LaunchDarkly.
    // Unite gates UI (including Verify Insurance) behind LD feature flags.
    return (
        url.includes('maps.googleapis.com') ||
        url.includes('intercom.io') ||
        url.includes('api-iam.intercom.io')
    );
}

function isLaunchDarkly(url) {
    return /launchdarkly\.com/i.test(url) || /launchdarkly\.net/i.test(url);
}

/** Hide obvious Playwright automation markers before any page JS runs. */
async function applyStealth(contextOrPage) {
    const script = () => {
        try {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        } catch (_) {}
        try {
            // Chromium headless often reports 0 plugins
            if (!navigator.plugins || navigator.plugins.length === 0) {
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [{ name: 'Chrome PDF Plugin' }],
                });
            }
        } catch (_) {}
        try {
            window.chrome = window.chrome || { runtime: {} };
        } catch (_) {}
    };
    if (typeof contextOrPage.addInitScript === 'function') {
        await contextOrPage.addInitScript(script);
    }
}

/** Route handler for a page (block noisy 3rd party; pass LaunchDarkly through unmodified). */
async function setupPageRoutes(p) {
    await p.route('**/*', async (route) => {
        const request = route.request();
        const url = request.url();

        // Feature flags — must reach Unite or Verify Insurance / other gated UI may never render
        if (isLaunchDarkly(url)) {
            return route.continue();
        }

        if (shouldAbortThirdParty(url)) {
            return route.abort();
        }

        if (url.includes('localhost') && url.includes('/api/')) {
            try {
                const response = await route.fetch();
                const headers = { ...response.headers() };
                const origin = request.headers()['origin'] || 'https://app.uniteus.io';
                headers['access-control-allow-origin'] = origin;
                headers['access-control-allow-credentials'] = 'true';
                return route.fulfill({ response, headers });
            } catch (e) {
                return route.continue();
            }
        }

        // Don't rewrite/proxy non-Unite traffic (fetch+fulfill was breaking LD/CDNs → ERR_FAILED)
        if (!url.includes('uniteus.io') && !url.includes('localhost') && !url.startsWith('data:')) {
            return route.continue();
        }

        return route.continue();
    });
}

async function prepareContext(ctx) {
    await applyStealth(ctx);
    await ctx.grantPermissions([], { origin: 'https://app.uniteus.io' });
    await ctx.clearPermissions();
}

/** Registry of multi-instance browsers for closeAllBrowserInstances(). */
const instances = new Map();

/** CDP screencast sessions keyed by slot id. Used when LIVE_VIEW=1 (portal jobs). */
const liveSessions = new Map();
const liveLastEmit = new Map();

function liveViewEnabled() {
    return process.env.LIVE_VIEW === '1';
}

function detachLive(slotId) {
    const id = String(slotId);
    const rec = liveSessions.get(id);
    liveSessions.delete(id);
    liveLastEmit.delete(id);
    if (rec && rec.cdp) {
        rec.cdp.detach().catch(() => {});
    }
}

/**
 * Stream JPEG frames from this page to the portal (global.__onLiveFrame).
 * Headless Chromium supports this; no virtual desktop is required.
 */
async function attachLiveView(slotId, page) {
    if (!liveViewEnabled() || !page) return;
    const id = String(slotId);
    detachLive(id);
    let cdp;
    try {
        cdp = await page.context().newCDPSession(page);
    } catch (e) {
        console.warn(`[Browser:${id}] Live view unavailable: ${e.message}`);
        return;
    }
    const rec = { cdp, page, lastMeta: null };
    liveSessions.set(id, rec);
    cdp.on('Page.screencastFrame', async (frame) => {
        try {
            if (frame && frame.metadata) rec.lastMeta = frame.metadata;
            const focused = String(global.__liveFocusSlot != null ? global.__liveFocusSlot : '0') === id;
            const minGap = focused ? 160 : 1000;
            const now = Date.now();
            const prevAt = liveLastEmit.get(id) || 0;
            if (now - prevAt >= minGap && typeof global.__onLiveFrame === 'function' && frame && frame.data) {
                liveLastEmit.set(id, now);
                const meta = frame.metadata || {};
                global.__onLiveFrame({
                    slotId: id,
                    data: frame.data,
                    w: meta.deviceWidth || 1400,
                    h: meta.deviceHeight || 900,
                });
            }
            if (frame && frame.sessionId != null) {
                await cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
            }
        } catch (_) { /* page closed */ }
    });
    try {
        await cdp.send('Page.startScreencast', {
            format: 'jpeg',
            quality: 55,
            maxWidth: 1280,
            maxHeight: 800,
            everyNthFrame: 1,
        });
        console.log(`[Browser:${id}] Live view started`);
    } catch (e) {
        console.warn(`[Browser:${id}] Screencast failed: ${e.message}`);
    }
}

async function handleLiveInput(msg) {
    if (!msg || msg.slotId == null) return;
    const rec = liveSessions.get(String(msg.slotId));
    if (!rec || !rec.page) return;
    const page = rec.page;
    const vp = typeof page.viewportSize === 'function' ? page.viewportSize() : null;
    const meta = rec.lastMeta || {};
    const w = meta.deviceWidth || (vp && vp.width) || 1400;
    const h = meta.deviceHeight || (vp && vp.height) || 900;
    const x = Math.max(0, Math.min(w - 1, Number(msg.x) * w));
    const y = Math.max(0, Math.min(h - 1, Number(msg.y) * h));
    const allowedKeys = new Set([
        'Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
        'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Space',
    ]);
    try {
        if (msg.kind === 'click') {
            await page.mouse.click(x, y);
        } else if (msg.kind === 'move') {
            await page.mouse.move(x, y);
        } else if (msg.kind === 'wheel') {
            await page.mouse.move(x, y);
            await page.mouse.wheel(0, Number(msg.deltaY) || 0);
        } else if (msg.kind === 'type' && msg.text) {
            const text = String(msg.text).slice(0, 32);
            await page.keyboard.type(text);
        } else if (msg.kind === 'key' && msg.key) {
            const key = String(msg.key);
            if (allowedKeys.has(key) || /^[a-zA-Z0-9]$/.test(key)) {
                await page.keyboard.press(key);
            }
        }
    } catch (e) {
        console.warn(`[Browser:${msg.slotId}] Live input failed: ${e.message}`);
    }
}

/**
 * Launch a dedicated browser instance for a slot (parallel mode).
 * Returns { browser, context, page, close, restartPage }.
 */
async function launchBrowserInstance(slotId) {
    console.log(`[Browser] Launching instance for slot ${slotId}...`);
    const b = await launchChromium();
    const ctx = await b.newContext(contextOptions());
    await prepareContext(ctx);
    const p = await ctx.newPage();
    await setupPageRoutes(p);
    p.on('console', (msg) => {
        if (msg.type() === 'log') console.log(`[Browser:${slotId}] ${msg.text()}`);
        if (msg.type() === 'warn') console.warn(`[Browser:${slotId}] ${msg.text()}`);
        if (msg.type() === 'error') console.error(`[Browser:${slotId}] ${msg.text()}`);
    });

    const close = async () => {
        instances.delete(slotId);
        detachLive(slotId);
        try {
            await b.close();
        } catch (e) {
            console.warn(`[Browser:${slotId}] Close error:`, e.message);
        }
    };

    const restartPage = async () => {
        await close();
        const next = await launchBrowserInstance(slotId);
        return next.page;
    };

    instances.set(slotId, { browser: b, context: ctx, page: p, close });
    await attachLiveView(slotId, p);
    return { browser: b, context: ctx, page: p, close, restartPage };
}

async function closeAllBrowserInstances() {
    const slots = Array.from(instances.keys());
    await Promise.all(
        slots.map(async (slotId) => {
            const inst = instances.get(slotId);
            if (inst && inst.close) await inst.close();
        })
    );
    instances.clear();
}

async function launchBrowser() {
    if (page) return page;

    console.log('[Browser] Launching Chromium...');
    browser = await launchChromium();
    context = await browser.newContext(contextOptions());
    await prepareContext(context);
    page = await context.newPage();
    await setupPageRoutes(page);
    page.on('console', (msg) => {
        if (msg.type() === 'log') console.log(`[Browser] ${msg.text()}`);
        if (msg.type() === 'warn') console.warn(`[Browser] ${msg.text()}`);
        if (msg.type() === 'error') console.error(`[Browser] ${msg.text()}`);
    });
    await attachLiveView(0, page);
    return page;
}

async function getPage() {
    if (!page) await launchBrowser();
    return page;
}

async function closeBrowser() {
    detachLive(0);
    if (browser) {
        await browser.close();
        browser = null;
        context = null;
        page = null;
    }
}

async function restartBrowser() {
    console.log('[Browser] Restarting browser for fresh session...');
    await closeBrowser();
    return await launchBrowser();
}

module.exports = {
    launchBrowser,
    getPage,
    closeBrowser,
    restartBrowser,
    getContext: () => context,
    launchBrowserInstance,
    closeAllBrowserInstances,
    handleLiveInput,
    attachLiveView,
};
