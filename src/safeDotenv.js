'use strict';
const fs = require('fs');
const dotenv = require('dotenv');

/**
 * Load .env without crashing when the file is unreadable (Windows EPERM in Downloads,
 * sync folders, AV locks). Existing process.env values remain in effect.
 */
function safeLoadDotenv(dotenvPath) {
    if (!dotenvPath || typeof dotenvPath !== 'string') {
        return { error: null };
    }
    if (!fs.existsSync(dotenvPath)) {
        return dotenv.config({ path: dotenvPath, override: true });
    }
    try {
        fs.accessSync(dotenvPath, fs.constants.R_OK);
    } catch (e) {
        console.warn(
            `[Env] Cannot read .env (${e.code || e.message}): ${dotenvPath}. ` +
                'Using process environment only. Check permissions, clear Read-only, unblock the folder (Properties), or move the project out of Downloads.'
        );
        return { parsed: {}, error: e };
    }
    try {
        return dotenv.config({ path: dotenvPath, override: true });
    } catch (e) {
        console.warn(`[Env] dotenv failed for ${dotenvPath}: ${e.message}`);
        return { parsed: {}, error: e };
    }
}

module.exports = { safeLoadDotenv };
