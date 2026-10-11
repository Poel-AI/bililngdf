const { WebSocketServer } = require('ws');
const auth = require('./auth');
const jobs = require('./jobManager');

function attach(server) {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
        let url;
        try {
            url = new URL(req.url, 'http://127.0.0.1');
        } catch (_) {
            socket.destroy();
            return;
        }
        const match = url.pathname.match(/^\/api\/jobs\/([a-f0-9]{16})\/live$/);
        if (!match) {
            socket.destroy();
            return;
        }
        const user = auth.userFromRequest(req);
        if (!user) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        const id = match[1];
        try {
            jobs.loadMeta(id);
        } catch (_) {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            const rt = jobs.ensureRuntime(id);
            rt.liveClients.add(ws);
            ws.on('message', (buf) => {
                let msg;
                try { msg = JSON.parse(buf.toString('utf8')); } catch (_) { return; }
                if (!msg || typeof msg !== 'object') return;
                if (msg.type === 'focus' && msg.slotId != null) {
                    jobs.sendToJob(id, { channel: 'focus', slotId: String(msg.slotId) });
                    return;
                }
                if (msg.type === 'input') {
                    jobs.sendToJob(id, {
                        channel: 'input',
                        kind: msg.kind,
                        slotId: msg.slotId,
                        x: msg.x,
                        y: msg.y,
                        deltaY: msg.deltaY,
                        text: msg.text,
                        key: msg.key,
                    });
                }
            });
            ws.on('close', () => rt.liveClients.delete(ws));
        });
    });
}

module.exports = { attach };
