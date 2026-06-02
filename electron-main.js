const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { safeLoadDotenv } = require('./src/safeDotenv');

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function ensureUserDataFiles() {
    const userData = app.getPath('userData');
    if (!fs.existsSync(userData)) {
        fs.mkdirSync(userData, { recursive: true });
    }

    const appPath = app.getAppPath();

    // Use bundled Playwright browsers when packaged (no install needed for users)
    if (app.isPackaged) {
        const bundledBrowsers = path.join(process.resourcesPath, 'playwright-browsers');
        if (fs.existsSync(bundledBrowsers)) {
            process.env.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers;
        }
    }
    // Dev: npm run install-browsers writes ./playwright-browsers — use that when present so local
    // Electron matches pack scripts. Otherwise use userData (matches packaged fallback).
    if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
        const projectBrowsers = path.join(appPath, 'playwright-browsers');
        if (!app.isPackaged && fs.existsSync(projectBrowsers)) {
            process.env.PLAYWRIGHT_BROWSERS_PATH = projectBrowsers;
        } else {
            process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(userData, 'playwright-browsers');
        }
    }

    // .env: dev uses project root; packaged copies bundled .env (your defaults at build time) into userData once,
    // then loads from userData so Save settings can update the file (ASAR-bundled .env is read-only).
    const appEnv = path.join(appPath, '.env');
    const envDest = path.join(userData, '.env');
    const envExample = path.join(appPath, '.env.example');
    const billingDest = path.join(userData, 'billing_requests.json');

    if (app.isPackaged) {
        // Bundled .env lives inside app.asar; userData copy is writable. Re-copy when the bundled file
        // changes (new build), so reinstall/upgrade picks up the .env you packed — not a stale userData file.
        const stampPath = path.join(userData, '.env.bundled.sha256');
        if (fs.existsSync(appEnv)) {
            const bundledHash = sha256File(appEnv);
            const prevHash = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, 'utf8').trim() : '';
            const needsSync = !fs.existsSync(envDest) || prevHash !== bundledHash;
            if (needsSync) {
                if (fs.existsSync(envDest) && prevHash !== bundledHash) {
                    fs.copyFileSync(envDest, path.join(userData, `.env.bak.${Date.now()}`));
                }
                fs.copyFileSync(appEnv, envDest);
                fs.writeFileSync(stampPath, bundledHash, 'utf8');
            }
        } else if (!fs.existsSync(envDest) && fs.existsSync(envExample)) {
            fs.copyFileSync(envExample, envDest);
        }
        process.env.DOTENV_PATH = envDest;
    } else {
        // Development: always use the repo .env next to electron-main.js (the file you edit in the IDE).
        // Previously, missing project .env sent DOTENV_PATH to userData, so npm run electron ignored your repo .env.
        const projectEnv = path.join(__dirname, '.env');
        const projectExample = path.join(__dirname, '.env.example');
        if (!fs.existsSync(projectEnv) && fs.existsSync(projectExample)) {
            try {
                fs.copyFileSync(projectExample, projectEnv);
            } catch (e) {
                console.warn(
                    `[Electron] Could not create ${projectEnv} (${e.code || e.message}). ` +
                        'Copy .env.example to .env manually or fix folder permissions.'
                );
            }
        }
        process.env.DOTENV_PATH = projectEnv;
    }

    if (!fs.existsSync(billingDest)) {
        const template = path.join(appPath, 'billing_requests_template.json');
        if (fs.existsSync(template)) {
            fs.copyFileSync(template, billingDest);
        }
    }

    process.env.BILLING_REQUESTS_PATH = billingDest;
}

function createWindow(port) {
    const iconPath = path.join(__dirname, 'public', 'logo.png');
    const win = new BrowserWindow({
        width: 1400,
        height: 820,
        title: 'Diet Fantasy Billing',
        icon: fs.existsSync(iconPath) ? iconPath : undefined,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
    });
    win.setTitle('Diet Fantasy Billing');
    win.loadURL(`http://localhost:${port}`);
    win.on('closed', () => {
        app.quit();
    });
}

app.whenReady().then(() => {
    const gotLock = app.requestSingleInstanceLock();
    if (!gotLock) {
        app.quit();
        return;
    }

    ensureUserDataFiles();

    const dotenvPath = process.env.DOTENV_PATH || path.join(__dirname, '.env');
    safeLoadDotenv(dotenvPath);
    const listenPort = Number(process.env.PORT) || 3500;
    console.log(`[Electron] Env file: ${dotenvPath} (exists: ${fs.existsSync(dotenvPath)})`);

    const { start } = require('./src/server');
    start(listenPort);

    createWindow(listenPort);
});

app.on('window-all-closed', () => {
    app.quit();
});
