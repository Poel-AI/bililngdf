const { chromium } = require('playwright');
const path = require('path');
const { safeLoadDotenv } = require('../safeDotenv');

const dotenvPath = process.env.DOTENV_PATH || path.join(__dirname, '..', '..', '.env');
safeLoadDotenv(dotenvPath);

let browser = null;
let context = null;
let page = null;

/** Shared launch options for Chromium (singleton and multi-instance). */
const launchOptions = () => ({
    headless: process.env.HEADLESS === 'true',
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials'
    ]
});

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
        if (msg.includes("Executable doesn't exist") || msg.includes('BrowserType.launch')) {
            throw new Error(`${msg}\n${playwrightBrowserHint()}`);
        }
        throw e;
    }
}

const contextOptions = () => ({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    permissions: [],
    geolocation: undefined,
    locale: 'en-US',
    bypassCSP: true,
    extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive'
    }
});

/** Route handler for a page (block 3rd party, CORS proxy for localhost/external). */
async function setupPageRoutes(p) {
    await p.route('**/*', async (route) => {
        const request = route.request();
        const url = request.url();
        if (
            url.includes('app.launchdarkly.com') ||
            url.includes('maps.googleapis.com') ||
            url.includes('intercom.io') ||
            url.includes('api-iam.intercom.io')
        ) {
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
        if (!url.includes('uniteus.io') && !url.includes('localhost') && !url.startsWith('data:')) {
            try {
                const response = await route.fetch();
                const headers = { ...response.headers() };
                headers['access-control-allow-origin'] = '*';
                headers['access-control-allow-credentials'] = 'true';
                return route.fulfill({ response, headers });
            } catch (e) {
                return route.continue();
            }
        }
        return route.continue();
    });
}

/** Registry of multi-instance browsers for closeAllBrowserInstances(). */
const instances = new Map();

/**
 * Launch a dedicated browser instance for a slot (parallel mode).
 * Returns { browser, context, page, close, restartPage }.
 */
async function launchBrowserInstance(slotId) {
    console.log(`[Browser] Launching instance for slot ${slotId}...`);
    const b = await launchChromium();
    const ctx = await b.newContext(contextOptions());
    await ctx.grantPermissions([], { origin: 'https://app.uniteus.io' });
    await ctx.clearPermissions();
    const p = await ctx.newPage();
    await setupPageRoutes(p);
    p.on('console', msg => {
        if (msg.type() === 'log') console.log(`[Browser:${slotId}] ${msg.text()}`);
        if (msg.type() === 'warn') console.warn(`[Browser:${slotId}] ${msg.text()}`);
        if (msg.type() === 'error') console.error(`[Browser:${slotId}] ${msg.text()}`);
    });

    const close = async () => {
        instances.delete(slotId);
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
    return { browser: b, context: ctx, page: p, close, restartPage };
}

async function closeAllBrowserInstances() {
    const slots = Array.from(instances.keys());
    await Promise.all(slots.map(async (slotId) => {
        const inst = instances.get(slotId);
        if (inst && inst.close) await inst.close();
    }));
    instances.clear();
}

async function launchBrowser() {
    if (page) return page;

    console.log('[Browser] Launching Chromium...');
    browser = await launchChromium();
    context = await browser.newContext(contextOptions());
    await context.grantPermissions([], { origin: 'https://app.uniteus.io' });
    await context.clearPermissions();
    page = await context.newPage();
    await setupPageRoutes(page);
    page.on('console', msg => {
        if (msg.type() === 'log') console.log(`[Browser] ${msg.text()}`);
        if (msg.type() === 'warn') console.warn(`[Browser] ${msg.text()}`);
        if (msg.type() === 'error') console.error(`[Browser] ${msg.text()}`);
    });
    return page;
}

async function getPage() {
    if (!page) await launchBrowser();
    return page;
}

async function closeBrowser() {
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
    closeAllBrowserInstances
};
