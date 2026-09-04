import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  clients, bumpClientId,
  send, broadcastLobby, handleDisconnect, handleReconnectRoom,
} from './server/rooms.js';
import { handleMessage } from './server/handlers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3131;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
};

// --- Static file server ---
const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// --- WebSocket ---
const wss = new WebSocketServer({ server });

// EADDRINUSE 由 server.on('error') 處理，抑制 WSS 的轉發
wss.on('error', () => {});

wss.on('connection', (ws) => {
  const tempId = 'c' + bumpClientId();
  let client = { id: tempId, ws, nickname: '訪客' + tempId.slice(1), roomId: null, role: null, connected: true, graceTimer: null };
  clients.set(tempId, client);
  send(ws, { type: 'welcome', clientId: tempId });
  broadcastLobby();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'reconnect' && msg.clientId) {
      const old = clients.get(msg.clientId);
      if (old && !old.connected) {
        if (old.graceTimer) clearTimeout(old.graceTimer);
        old.ws = ws; old.connected = true; old.graceTimer = null;
        clients.delete(tempId);
        client = old;
        send(ws, { type: 'welcome', clientId: old.id, reconnected: true });
        handleReconnectRoom(old);
        return;
      }
    }
    handleMessage(client, msg);
  });
  ws.on('close', () => handleDisconnect(client));
});

function findPortPid(port) {
  if (process.platform === 'win32') {
    const out = execSync('netstat -ano', { encoding: 'utf8' });
    const re = new RegExp(`:${port}\\b`);
    const line = out.split('\n').find(l => re.test(l) && l.includes('LISTENING'));
    return line ? line.trim().split(/\s+/).pop() : null;
  }
  return execSync(`lsof -ti :${port}`, { encoding: 'utf8' }).trim().split('\n')[0] || null;
}

let retried = false;
server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE' || retried) throw err;
  retried = true;
  console.log(`Port ${PORT} 被占用，正在關閉舊程序…`);
  try {
    const pid = findPortPid(PORT);
    if (pid) process.kill(Number(pid));
  } catch {}
  setTimeout(() => server.listen(PORT), 1000);
});

server.listen(PORT, () => {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  console.log('========================================');
  console.log(' LAN Hub 已啟動');
  console.log(` 本機開啟: http://localhost:${PORT}`);
  for (const a of addrs) console.log(` 同 WiFi 的人開啟: http://${a}:${PORT}`);
  console.log('========================================');
});
