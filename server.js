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

// Creator codes -> player IDs. Built-in defaults below; the host can add or override them with
// CREATOR_CODES="AUSTEN:P-abc123...,BECKET:P-def456..." (quotes, spaces and letter case are forgiven).
const PID_RE = /^P-[a-z0-9]{10,24}$/;
const DEFAULT_CREATORS = { AUSTEN: 'P-rsz9g6j79f', BECKET: 'P-0hljmdl1ka' };
function parseCreators(raw) {
  const out = {};
  for (const part of String(raw || '').replace(/["'\s]/g, '').split(/[,;]/)) {
    const m = /^([A-Za-z0-9_]+)[:=]([Pp]-[A-Za-z0-9]+)$/.exec(part);
    if (!m) continue;
    const pid = 'P-' + m[2].slice(2).toLowerCase();
    if (PID_RE.test(pid)) out[m[1].toUpperCase()] = pid;
  }
  return out;
}
const CREATORS = { ...DEFAULT_CREATORS, ...parseCreators(process.env.CREATOR_CODES) };
const byPid = new Map(); // player ID -> Set(client)
// Leaderboards (Squad Waves best wave, Boss Raid furthest round): player ID -> { n, w, s }.
// Clients re-upload their cached copies, so the boards survive restarts.
const BOARDS = { waves: new Map(), boss: new Map() };
function lbTop(LB = BOARDS.waves) { return [...LB.entries()].map(([pid, v]) => ({ pid, n: v.n, w: v.w, s: v.s })).sort((a, b) => b.w - a.w || b.s - a.s).slice(0, 100); }
function lbMerge(client, entries, LB = BOARDS.waves) {
  if (!Array.isArray(entries)) return;
  for (const e of entries.slice(0, 60)) {
    if (!e || typeof e.pid !== 'string' || !PID_RE.test(e.pid)) continue;
    const w = Math.floor(+e.w), sc = Math.max(0, Math.floor(+e.s || 0));
    if (!(w > 0 && w < 1000) || sc > 1e9) continue;
    const n = String(e.n || 'Pilot').replace(/[\u0000-\u001f]/g, '').slice(0, 14) || 'Pilot', cur = LB.get(e.pid);
    // a player's own submission also updates their name; copies relayed from other players only fill gaps or raise scores
    if (e.pid === client.pid) LB.set(e.pid, { n, w: Math.max(w, cur?.w || 0), s: Math.max(sc, cur?.s || 0) });
    else if (!cur || w > cur.w || (w === cur.w && sc > cur.s)) LB.set(e.pid, { n: cur?.n || n, w: Math.max(w, cur?.w || 0), s: Math.max(sc, cur?.s || 0) });
  }
  if (LB.size > 1000) {
    const all = [...LB.entries()].sort((a, b) => b[1].w - a[1].w || b[1].s - a[1].s);
    for (const [pid] of all.slice(1000)) LB.delete(pid);
  }
}
// Player profiles (look + stats). Each player re-uploads their own whenever they connect.
const PROF = new Map();
const STAT_KEYS = ['k', 'd', 'w', 'bk', 'inf', 'gp', 'pt', 'ch', 'bw', 'bs', 'br'];
function cleanProfile(p) {
  if (!p || typeof p !== 'object') return null;
  const num = v => Math.max(0, Math.min(1e9, Math.floor(+v || 0)));
  const str = (v, n) => String(v || '').replace(/[\u0000-\u001f]/g, '').slice(0, n);
  const st = p.st && typeof p.st === 'object' ? p.st : {};
  return { n: str(p.n, 14) || 'Pilot', h: num(p.h) % 360, sk: str(p.sk, 16), fn: str(p.fn, 16), ht: str(p.ht, 16), cl: str(p.cl, 12),
    st: Object.fromEntries(STAT_KEYS.map(k => [k, num(st[k])])), since: Math.max(0, Math.min(Date.now(), Math.floor(+p.since || 0))) };
}
const seen = new Map();  // player ID -> { name, last, room } for the /players lookup page
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function playersPage() {
  const now = Date.now();
  const rows = [...seen.entries()].sort((a, b) => b[1].last - a[1].last).map(([pid, v]) => {
    const online = byPid.has(pid);
    const ago = online ? 'online now' : `${Math.round((now - v.last) / 60000)} min ago`;
    return `<tr><td>${esc(v.name || '(no name yet)')}</td><td><code>${esc(pid)}</code></td><td>${esc(v.room || '')}</td><td>${ago}</td></tr>`;
  }).join('');
  const codes = Object.keys(CREATORS).length ? Object.entries(CREATORS).map(([c, p]) => `${esc(c)} → <code>${esc(p)}</code>`).join('<br>') : 'None set yet. Add CREATOR_CODES in your host settings.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prism Arena players</title>
<style>body{font:15px system-ui,sans-serif;margin:0;padding:24px 16px;background:#0b0916;color:#eef2ff}h1{font-size:20px;margin:0 0 6px}p{color:#a7abcc;max-width:70ch}
table{border-collapse:collapse;width:100%;max-width:900px;margin-top:14px}td,th{text-align:left;padding:8px 10px;border-bottom:1px solid #2a2545}th{color:#a7abcc;font-weight:500;font-size:12px;letter-spacing:.1em;text-transform:uppercase}
code{font-size:14px;color:#5ff2ff}.wrap{overflow-x:auto}</style></head><body>
<h1>Players seen since the server last started</h1>
<p>Find a creator's callsign and copy their player ID into the CREATOR_CODES setting. The list resets whenever the server restarts, so check it while they're online.</p>
<p><b>Creator codes now:</b><br>${codes}</p>
<div class="wrap"><table><thead><tr><th>Callsign</th><th>Player ID</th><th>Room</th><th>Last seen</th></tr></thead><tbody>${rows || '<tr><td colspan="4">Nobody yet.</td></tr>'}</tbody></table></div>
</body></html>`;
}

// The game file is written as page content (no <html>/<head>), so wrap it in a full document.
function page() {
  const body = fs.readFileSync(GAME_FILE, 'utf8');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<meta name="description" content="Prism Arena: a first-person sky arena shooter. Squad Waves, Boss Raid, Free-for-All, Gun Game, Capture the Flag and Infection.">' +
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
  } else if (url === '/leaderboard') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(lbTop().map(({ n, w, s }) => ({ name: n, wave: w, score: s }))));
  } else if (url === '/players') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(playersPage());
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
    if (m.t === 'id' && typeof m.pid === 'string' && PID_RE.test(m.pid) && !client.pid) {
      client.pid = m.pid;
      if (!byPid.has(m.pid)) byPid.set(m.pid, new Set());
      byPid.get(m.pid).add(client);
      seen.set(m.pid, { ...(seen.get(m.pid) || {}), last: Date.now() });
    } else if (m.t === 'pay' && client.pid && typeof m.id === 'string' && m.id.length < 80) {
      // route a creator-code payout to the creator's player ID if they're online; the buyer retries until acked
      const target = CREATORS[String(m.code || '').toUpperCase()];
      if (!target) return;
      if (target === client.pid) { send(ws, JSON.stringify({ t: 'ack', id: m.id })); return; }
      const amount = Math.max(0, Math.min(500, Math.floor(+m.amount || 0)));
      const msg = JSON.stringify({ t: 'pay', id: m.id, amount, code: String(m.code).toUpperCase(), from: client.pid });
      for (const o of byPid.get(target) || []) send(o.ws, msg);
    } else if (m.t === 'lb' && client.pid) {
      // older pages send no board name: that's the Squad Waves board, and they only get that board back
      const board = BOARDS[m.board] ? m.board : 'waves';
      lbMerge(client, m.entries, BOARDS[board]);
      send(ws, JSON.stringify({ t: 'lbtop', board, list: lbTop(BOARDS[board]) }));
    } else if (m.t === 'lbget') {
      const boards = Array.isArray(m.boards) ? m.boards.filter(b => BOARDS[b]) : ['waves'];
      for (const board of boards) send(ws, JSON.stringify({ t: 'lbtop', board, list: lbTop(BOARDS[board]) }));
    } else if (m.t === 'prof' && client.pid) {
      const pr = cleanProfile(m.p);
      if (pr) { PROF.delete(client.pid); PROF.set(client.pid, pr); if (PROF.size > 5000) PROF.delete(PROF.keys().next().value); }
    } else if (m.t === 'profget' && typeof m.pid === 'string' && PID_RE.test(m.pid)) {
      send(ws, JSON.stringify({ t: 'profile', pid: m.pid, p: PROF.get(m.pid) || null, on: byPid.has(m.pid), room: seen.get(m.pid)?.room || '' }));
    } else if (m.t === 'who' && Array.isArray(m.pids)) {
      // friends list status: online, current room, last seen
      const list = m.pids.slice(0, 100).filter(x => typeof x === 'string' && PID_RE.test(x)).map(pid => {
        const v = seen.get(pid) || {};
        return { pid, on: byPid.has(pid), n: PROF.get(pid)?.n || v.name || '', room: byPid.has(pid) ? v.room || '' : '', last: v.last || 0 };
      });
      send(ws, JSON.stringify({ t: 'whois', list }));
    } else if (m.t === 'invite' && client.pid && typeof m.to === 'string' && PID_RE.test(m.to)) {
      const now = Date.now(); if (now - (client.invT || 0) < 1500) return; client.invT = now;
      const str = (v, n) => String(v || '').replace(/[^a-z0-9-]/gi, '').slice(0, n);
      const msg = JSON.stringify({ t: 'invite', from: client.pid, n: String(m.n || '').replace(/[\u0000-\u001f]/g, '').slice(0, 14), mode: str(m.mode, 10), map: str(m.map, 10), room: str(m.room, 20).toLowerCase() });
      const targets = byPid.get(m.to);
      for (const o of targets || []) send(o.ws, msg);
      send(ws, JSON.stringify({ t: 'invsent', to: m.to, ok: !!(targets && targets.size) }));
    } else if (m.t === 'ack' && client.pid && typeof m.id === 'string' && typeof m.to === 'string') {
      const msg = JSON.stringify({ t: 'ack', id: m.id });
      for (const o of byPid.get(m.to) || []) send(o.ws, msg);
    } else if (m.t === 'join' && typeof m.room === 'string') {
      leave(client);
      const name = m.room.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 48) || 'pa-waves-public';
      let r = rooms.get(name);
      if (!r) { r = new Map(); rooms.set(name, r); }
      if (r.size >= MAX_ROOM) { send(ws, JSON.stringify({ t: 'full' })); return; }
      client.room = name; client.d = {}; r.set(client.id, client);
      send(ws, JSON.stringify({ t: 'peers', list: [...r.values()].map(o => ({ id: o.id, d: o.d })) }));
    } else if (m.t === 'p' && client.room && m.d && typeof m.d === 'object') {
      client.d = m.d;
      if (client.pid) seen.set(client.pid, { name: String(m.d.n || '').slice(0, 20), room: client.room, last: Date.now() });
      const r = rooms.get(client.room); if (!r) return;
      const msg = JSON.stringify({ t: 'u', id: client.id, d: m.d });
      for (const o of r.values()) if (o !== client) send(o.ws, msg);
    }
  });
  ws.on('close', () => {
    leave(client);
    if (client.pid) { const set = byPid.get(client.pid); if (set) { set.delete(client); if (!set.size) byPid.delete(client.pid); } }
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 15000);

server.listen(PORT, () => console.log(`Prism Arena running at http://localhost:${PORT}`));
