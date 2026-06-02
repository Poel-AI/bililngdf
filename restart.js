#!/usr/bin/env node

const path = require('path');
const { safeLoadDotenv } = require('./src/safeDotenv');

safeLoadDotenv(path.join(__dirname, '.env'));
const { execSync } = require('child_process');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3500;

console.log(`Checking for processes on port ${PORT}...`);

try {
    // Find processes using the port
    const pids = execSync(`lsof -ti:${PORT}`, { encoding: 'utf8' }).trim();

    if (pids) {
        console.log(`Found processes on port ${PORT}: ${pids}`);
        console.log('Killing processes with force...');

        // Kill each process with -9 (force kill)
        pids.split('\n').forEach(pid => {
            if (pid.trim()) {
                try {
                    execSync(`kill -9 ${pid.trim()}`);
                } catch (e) {
                    // Process might already be dead, ignore
                }
            }
        });

        // Wait a moment for cleanup
        setTimeout(() => {
            startServer();
        }, 1000); // Reduced wait time slightly since we forced kill
    } else {
        console.log(`No processes found on port ${PORT}.`);
        startServer();
    }
} catch (e) {
    // No processes found (lsof returns error when no matches), that's fine
    console.log(`No processes found on port ${PORT}.`);
    startServer();
}

function startServer() {
    console.log('Starting server...');
    const server = spawn('node', ['src/server.js'], {
        stdio: 'inherit',
        shell: true
    });

    server.on('error', (err) => {
        console.error('Failed to start server:', err);
        process.exit(1);
    });

    // Handle Ctrl+C
    process.on('SIGINT', () => {
        console.log('\nShutting down server...');
        server.kill();
        process.exit(0);
    });
}

