// Prism Arena website server: serves the game page and relays multiplayer presence over WebSockets.
//   npm install        (once)
//   npm start          -> http://localhost:3000
//   node server.js --build   -> writes dist/index.html for static hosts (solo + bots only, no multiplayer)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GAME_FILE = path.join(__dirname, 'prism-arena.html');
const PORT = process.env.PORT || 3000;
const MAX_ROOM = 12;
const MAX_MSG = 16 * 1024;

// The game file is written as page content (no <html>/<head>), so wrap it in a full document.
function page() {
  const body = fs.readFileSync(GAME_FILE, 'utf8');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<meta name="description" content="Prism Arena: a first-person sky arena shooter. Squad Waves, Gun Game and Capture the Flag.">' +
    '<style>body{margin:0}[hidden]{display:none!important}</style></head><body>' + body + '</body></html>';
}

if (process.argv.includes('--build')) {
  fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'dist', 'index.html'), page());
  console.log('Wrote dist/index.html');
  process.exit(0);
}

const { WebSocketServer } = require('ws');

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(page());
  } else if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
  }
});

const rooms = new Map(); // room name -> Map(id -> { ws, d })
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MSG });

function send(ws, msg) { if (ws.readyState === 1) ws.send(msg); }
function leave(client) {
  if (!client.room) return;
  const r = rooms.get(client.room);
  if (r) {
    r.delete(client.id);
    const bye = JSON.stringify({ t: 'bye', id: client.id });
    for (const o of r.values()) send(o.ws, bye);
    if (!r.size) rooms.delete(client.room);
  }
  client.room = null;
}

wss.on('connection', ws => {
  const client = { id: crypto.randomBytes(6).toString('hex'), ws, room: null, d: {} };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  send(ws, JSON.stringify({ t: 'hello', id: client.id }));
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join' && typeof m.room === 'string') {
      leave(client);
      const name = m.room.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 48) || 'pa-waves-public';
      let r = rooms.get(name);
      if (!r) { r = new Map(); rooms.set(name, r); }
      if (r.size >= MAX_ROOM) { send(ws, JSON.stringify({ t: 'full' })); return; }
      client.room = name; client.d = {}; r.set(client.id, client);
      send(ws, JSON.stringify({ t: 'peers', list: [...r.values()].map(o => ({ id: o.id, d: o.d })) }));
    } else if (m.t === 'p' && client.room && m.d && typeof m.d === 'object') {
      client.d = m.d;
      const r = rooms.get(client.room); if (!r) return;
      const msg = JSON.stringify({ t: 'u', id: client.id, d: m.d });
      for (const o of r.values()) if (o !== client) send(o.ws, msg);
    }
  });
  ws.on('close', () => leave(client));
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 15000);

server.listen(PORT, () => console.log(`Prism Arena running at http://localhost:${PORT}`));
