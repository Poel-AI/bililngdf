const fs = require('fs');
const path = require('path');

const p =
    process.argv[2] ||
    path.join(process.env.APPDATA || '', 'df-billing-automation-server', 'billing_session.json');

if (!fs.existsSync(p)) {
    console.error('Not found:', p);
    process.exit(1);
}

const stat = fs.statSync(p);
console.log('File:', p);
console.log('Size MB:', (stat.size / 1024 / 1024).toFixed(2));

const head = fs.readFileSync(p, 'utf8', { start: 0, end: 500000 });
const meta = head.match(/"updatedAt"\s*:\s*"([^"]+)"/);
const completed = head.match(/"completed"\s*:\s*(true|false)/);
console.log('updatedAt:', meta ? meta[1] : '?');
console.log('completed:', completed ? completed[1] : '?');

const reqStart = head.indexOf('"requests"');
const arrStart = head.indexOf('[', reqStart);
let depth = 0;
let objStart = -1;
for (let i = arrStart + 1; i < head.length; i++) {
    const c = head[i];
    if (c === '{') {
        if (depth === 0) objStart = i;
        depth++;
    } else if (c === '}') {
        depth--;
        if (depth === 0 && objStart >= 0) {
            try {
                const obj = JSON.parse(head.slice(objStart, i + 1));
                console.log('\nFirst request field sizes:');
                for (const [k, v] of Object.entries(obj)) {
                    let size = 0;
                    if (typeof v === 'string') size = v.length;
                    else if (Array.isArray(v)) size = JSON.stringify(v).length;
                    else if (v && typeof v === 'object') size = JSON.stringify(v).length;
                    else size = String(v).length;
                    if (size > 100) console.log(`  ${k}: ${size} chars`);
                }
                console.log('Keys:', Object.keys(obj).join(', '));
            } catch (e) {
                console.error('Parse first request failed:', e.message);
            }
            break;
        }
    }
}

// Sample status counts via streaming-ish read
const content = fs.readFileSync(p, 'utf8');
let requests;
try {
    const data = JSON.parse(content);
    requests = data.requests || [];
    console.log('\nRequest count:', requests.length);
    const statuses = {};
    let totalJson = 0;
    let maxReq = { name: '', size: 0 };
    for (const r of requests) {
        const st = r.status || 'pending';
        statuses[st] = (statuses[st] || 0) + 1;
        const sz = JSON.stringify(r).length;
        totalJson += sz;
        if (sz > maxReq.size) maxReq = { name: r.name || r.id, size: sz, id: r.id };
    }
    console.log('Statuses:', statuses);
    console.log('Avg request JSON bytes:', Math.round(totalJson / requests.length));
    console.log('Largest request:', maxReq);
    const bigFields = {};
    for (const r of requests.slice(0, 50)) {
        for (const [k, v] of Object.entries(r)) {
            const sz =
                typeof v === 'string'
                    ? v.length
                    : v && typeof v === 'object'
                      ? JSON.stringify(v).length
                      : 0;
            if (sz > 1000) bigFields[k] = Math.max(bigFields[k] || 0, sz);
        }
    }
    console.log('Large fields (first 50 reqs):', bigFields);
} catch (e) {
    console.error('Full parse failed:', e.message);
}
