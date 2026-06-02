const fs = require('fs');
const path = require('path');

const logPath =
    process.argv[2] ||
    path.join(process.env.APPDATA || '', 'df-billing-automation-server', 'server.log');

if (!fs.existsSync(logPath)) {
    console.error('Missing:', logPath);
    process.exit(1);
}

const stat = fs.statSync(logPath);
console.log('Log:', logPath);
console.log('Size MB:', (stat.size / 1024 / 1024).toFixed(1));
console.log('Modified:', stat.mtime.toISOString());

const TAIL_BYTES = 2 * 1024 * 1024;
const fd = fs.openSync(logPath, 'r');
const start = Math.max(0, stat.size - TAIL_BYTES);
const buf = Buffer.alloc(stat.size - start);
fs.readSync(fd, buf, 0, buf.length, start);
fs.closeSync(fd);
const tail = buf.toString('utf8');
const lines = tail.split('\n').filter(Boolean);

console.log('\n=== Last 30 lines ===');
lines.slice(-30).forEach((l) => console.log(l));

const patterns = [
    'CRITICAL AUTOMATION ERROR',
    'uncaughtException',
    'unhandledRejection',
    'JavaScript heap',
    'ENOMEM',
    'Maximum call stack',
    'Automation Run Complete',
    'Starting Automation Run',
    'Starting ',
    ' browsers in parallel',
    'Session Compacting',
    'Compacted to',
    'Final attempt failed',
    'Session failed',
    'Could not save progress',
    'Log file:',
    'Server running',
    'RADAR',
    'AppHang',
];

console.log('\n=== Pattern hits in last 2MB ===');
for (const p of patterns) {
    const hits = lines.filter((l) => l.includes(p));
    if (hits.length) {
        console.log(`\n-- ${p} (${hits.length}) --`);
        hits.slice(-5).forEach((l) => console.log(l.slice(0, 300)));
    }
}

// Count error types in tail
const errCounts = {};
for (const l of lines) {
    if (!l.includes('[error]')) continue;
    const m = l.match(/\[error\]\s*(.+)/);
    const key = m ? m[1].slice(0, 80) : 'unknown';
    errCounts[key] = (errCounts[key] || 0) + 1;
}
console.log('\n=== Top error messages in last 2MB ===');
Object.entries(errCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .forEach(([k, n]) => console.log(n, k));

// Scan whole file for critical markers (streaming)
console.log('\n=== Full-file critical scan ===');
const scanPatterns = [
    'CRITICAL AUTOMATION ERROR',
    'uncaughtException',
    'unhandledRejection',
    'JavaScript heap out of memory',
    'Maximum call stack size exceeded',
];
const stream = fs.createReadStream(logPath, { encoding: 'utf8', highWaterMark: 1024 * 1024 });
let leftover = '';
let lineNo = 0;
const found = {};
stream.on('data', (chunk) => {
    const text = leftover + chunk;
    const parts = text.split('\n');
    leftover = parts.pop();
    for (const line of parts) {
        lineNo++;
        for (const p of scanPatterns) {
            if (line.includes(p)) {
                if (!found[p]) found[p] = [];
                if (found[p].length < 5) found[p].push({ lineNo, line: line.slice(0, 400) });
            }
        }
    }
});
stream.on('end', () => {
    for (const [p, hits] of Object.entries(found)) {
        console.log(`\n${p}: ${hits.length} sample(s)`);
        hits.forEach((h) => console.log(`  L${h.lineNo}: ${h.line}`));
    }
    if (Object.keys(found).length === 0) console.log('No Node crash markers in full log.');
});
