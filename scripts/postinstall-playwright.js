'use strict';
const { execSync } = require('child_process');
const path = require('path');

if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1') {
    console.log('[postinstall] Skipping Playwright chromium (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1).');
    process.exit(0);
}

const browsersPath = path.join(process.cwd(), 'playwright-browsers');
const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath };

try {
    execSync('npx playwright install chromium', { stdio: 'inherit', env });
} catch (e) {
    console.warn('[postinstall] Playwright install failed (offline CI?). Run: npm run install-browsers');
    console.warn(e.message || e);
    process.exit(0);
}
