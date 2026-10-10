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
// Battle Royale rooms hold up to 50 players (plus a couple of spare slots)
const roomCap = name => /^pa-royale-/.test(name) ? 52 : MAX_ROOM;
const MAX_MSG = 64 * 1024;

// Creator codes -> player IDs. Built-in defaults below; the host can add or override them with
// CREATOR_CODES="AUSTEN:P-abc123...,BECKET:P-def456..." (quotes, spaces and letter case are forgiven).
const PID_RE = /^P-[a-z0-9]{10,24}$/;
const DEFAULT_CREATORS = { AUSTEN: 'P-rsz9g6j79f', BECKET: 'P-0hljmdl1ka', JMONEY: 'P-yi5oe6n8if', HARRYBALLS: 'P-ngk4h530nz' };
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
// Linked accounts: one person's player IDs on different devices share one wallet (coins + cosmetics) and creator-code payouts.
// The first ID in each group is the main one. Players link their own accounts from their Profile: each account types in
// the other's ID, and once both have asked, the two are joined. Groups live here, in data/links.json, and in a signed
// token every linked device keeps, so links survive the host wiping its disk (set LINK_SECRET in the host's env so the
// tokens stay valid across redeploys).
const LINKS = [
  ['P-ngk4h530nz', 'P-k6s7z2dfih'], // Harry (creator code HARRYBALLS)
];
const LINK_MAX = 4, LINKS_FILE = path.join(__dirname, 'data', 'links.json');
const LINK_SECRET = process.env.LINK_SECRET || (() => {
  const f = path.join(__dirname, 'data', 'link_secret');
  try { const s = fs.readFileSync(f, 'utf8').trim(); if (s.length >= 32) return s; } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); } catch {}
  return s;
})();
const groupOf = pid => LINKS.find(g => g.includes(pid)) || null;
const sameGroup = (a, b) => a === b || (!!groupOf(a) && groupOf(a) === groupOf(b));
const membersOf = pid => groupOf(pid) || [pid];
// first online client for a player ID or any of its linked IDs
function clientFor(pid) { for (const id of membersOf(pid)) { const set = byPid.get(id); if (set && set.size) return set.values().next().value; } return null; }
const linkSig = g => crypto.createHmac('sha256', LINK_SECRET).update(g.join(',')).digest('hex').slice(0, 40);
let linksDirty = false;
try { for (const g of JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'))) if (Array.isArray(g) && g.length >= 2 && g.length <= LINK_MAX && g.every(p => PID_RE.test(p)) && !g.some(groupOf)) LINKS.push(g); } catch {}
setInterval(() => { if (!linksDirty) return; linksDirty = false; try { fs.mkdirSync(path.dirname(LINKS_FILE), { recursive: true }); fs.writeFileSync(LINKS_FILE, JSON.stringify(LINKS)); } catch {} }, 5000);
// tell every online device in a group that it's linked (and hand it the signed token)
function linkAnnounce(g) {
  const msg = JSON.stringify({ t: 'linked', main: g[0], g, sig: linkSig(g) });
  for (const id of g) for (const c of byPid.get(id) || []) send(c.ws, msg);
}
// join two accounts; returns an error message, or '' when it worked
function linkJoin(a, b) {
  const ga = groupOf(a), gb = groupOf(b);
  if (ga && ga === gb) return 'These accounts are already linked';
  if (ga && gb) return 'Both accounts are already linked to other accounts';
  const g = [...new Set([...(ga || gb || []), a, b])];
  if (g.length > LINK_MAX) return `You can link up to ${LINK_MAX} accounts together`;
  if (ga) LINKS.splice(LINKS.indexOf(ga), 1); if (gb) LINKS.splice(LINKS.indexOf(gb), 1);
  LINKS.push(g); linksDirty = true; linkAnnounce(g);
  return '';
}
const LINKREQ = new Map(); // 'from>to' -> expiry time
const LINKREQ_MS = 15 * 60 * 1000;
function linkInfo(pid) {
  const now = Date.now(), inc = [], out = [];
  for (const [k, exp] of LINKREQ) { if (exp < now) { LINKREQ.delete(k); continue; } const [f, t] = k.split('>'); if (t === pid) inc.push({ pid: f, n: PROF.get(f)?.n || seen.get(f)?.name || '' }); if (f === pid) out.push({ pid: t, n: PROF.get(t)?.n || seen.get(t)?.name || '' }); }
  const g = groupOf(pid);
  return { t: 'linkinfo', g: g ? g.map(p => ({ pid: p, n: PROF.get(p)?.n || seen.get(p)?.name || '', on: byPid.has(p) && byPid.get(p).size > 0 })) : null, inc, out, max: LINK_MAX };
}
function linkMessage(client, m) {
  const pid = client.pid, reply = o => send(client.ws, JSON.stringify(o));
  if (m.op === 'info') return reply(linkInfo(pid));
  if (m.op === 'req' || m.op === 'no') {
    const to = typeof m.to === 'string' ? m.to : '';
    if (!PID_RE.test(to)) return reply({ t: 'linkst', err: 'That doesn\'t look like a player ID' });
    if (m.op === 'no') { LINKREQ.delete(`${to}>${pid}`); LINKREQ.delete(`${pid}>${to}`); return reply(linkInfo(pid)); }
    if (to === pid) return reply({ t: 'linkst', err: 'That\'s this account\'s own ID. Type the ID of your other account' });
    if (sameGroup(pid, to)) return reply({ t: 'linkst', err: 'These accounts are already linked' });
    const back = LINKREQ.get(`${to}>${pid}`);
    if (back && back > Date.now()) {
      // both accounts asked: link them
      LINKREQ.delete(`${to}>${pid}`); LINKREQ.delete(`${pid}>${to}`);
      const err = linkJoin(pid, to);
      for (const id of [pid, to]) for (const c of byPid.get(id) || []) send(c.ws, JSON.stringify(err ? { t: 'linkst', err } : { t: 'linkst', ok: 'Accounts linked! Coins and items are now shared.' }));
      for (const id of membersOf(pid)) for (const c of byPid.get(id) || []) send(c.ws, JSON.stringify(linkInfo(id)));
      return;
    }
    if ([...LINKREQ.keys()].filter(k => k.startsWith(pid + '>')).length >= 5) return reply({ t: 'linkst', err: 'Too many open link requests. Wait a few minutes' });
    LINKREQ.set(`${pid}>${to}`, Date.now() + LINKREQ_MS);
    const n = PROF.get(pid)?.n || seen.get(pid)?.name || '';
    for (const c of byPid.get(to) || []) { send(c.ws, JSON.stringify({ t: 'linkreq', from: pid, n })); send(c.ws, JSON.stringify(linkInfo(to))); }
    reply({ t: 'linkst', ok: `Step 1 done. Now open Profile on your other account (${to}) within 15 minutes and type in this account's ID: ${pid}` });
    return reply(linkInfo(pid));
  }
  if (m.op === 'restore' && Array.isArray(m.g) && typeof m.sig === 'string') {
    // a device brings back a link the server forgot (its disk was wiped); the signature proves the server made it
    const g = m.g.slice(0, LINK_MAX + 1).map(String);
    if (g.length < 2 || g.length > LINK_MAX || !g.every(p => PID_RE.test(p)) || !g.includes(pid) || new Set(g).size !== g.length) return;
    const want = linkSig(g); if (m.sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(m.sig), Buffer.from(want))) return;
    const have = [...new Set(g.map(groupOf).filter(Boolean))];
    if (have.length === 1 && have[0].length === g.length) return; // already known
    if (have.some(h => h.some(p => !g.includes(p)))) return; // something newer already covers these accounts
    for (const h of have) LINKS.splice(LINKS.indexOf(h), 1);
    LINKS.push(g); linksDirty = true;
    if (!have.length || have.some(h => h.length !== g.length)) linkAnnounce(g);
  }
}
// Shared wallets, keyed by the group's main ID. Kept in memory: after a restart the devices re-seed it from their
// last confirmed copy (the highest version wins), then replay any changes the server never confirmed.
const WAL = new Map();
const ITEM_RE = /^(suit|hat|finish|pet|emote|spray|addon):[a-z0-9]{1,24}$/;
function walMessage(client, m) {
  const g = groupOf(client.pid); if (!g) return;
  const num = (v, max) => Math.max(-max, Math.min(max, Math.floor(+v || 0)));
  let R = WAL.get(g[0]); const fresh = !R;
  if (!R) { R = { coins: 0, ver: 0, owned: new Set(), joined: new Set(), seq: new Map() }; WAL.set(g[0], R); }
  if (m.first) { if (!R.joined.has(client.pid)) R.coins += Math.max(0, num(m.own, 1e12)); }
  else if (fresh || num(m.ver, 1e12) > R.ver) { R.coins = Math.max(0, num(m.base, 1e12)); R.ver = Math.max(0, num(m.ver, 1e12)); }
  R.joined.add(client.pid);
  const seq = num(m.seq, 1e12);
  if (seq > 0 && seq > (R.seq.get(client.pid) || 0)) { R.coins = Math.max(0, R.coins + num(m.delta, 1e12)); R.seq.set(client.pid, seq); }
  if (Array.isArray(m.owned)) for (const it of m.owned.slice(0, 1000)) if (typeof it === 'string' && ITEM_RE.test(it) && R.owned.size < 1000) R.owned.add(it);
  R.ver++;
  const owned = [...R.owned];
  for (const id of g) for (const c of byPid.get(id) || []) send(c.ws, JSON.stringify({ t: 'wal', main: g[0], coins: R.coins, ver: R.ver, owned, ack: c === client ? seq : 0 }));
}
// One-off coin gifts from the game owner, delivered whenever that player connects. Each gift has a fixed ID,
// and the player's browser remembers gift IDs forever, so resending (after restarts) never pays twice.
const GIFTS = [
  { id: 'gift-jmoney-10k', pid: 'P-yi5oe6n8if', amount: 10000 },
  { id: 'gift-jmoney-9999999999', pid: 'P-yi5oe6n8if', amount: 9999999999 },
  { id: 'gift-harry-walla', pid: 'P-ngk4h530nz', item: 'suit:walla' },
  { id: 'gift-r8sp-burgerman', pid: 'P-r8spcxqegc', item: 'suit:burgerman' },
];
function sendGifts(client) {
  for (const g of GIFTS) if (g.pid === client.pid || (g.item && !g.amount && sameGroup(g.pid, client.pid))) send(client.ws, JSON.stringify({ t: 'pay', id: g.id, amount: g.amount || 0, item: g.item || '', code: 'GIFT', gift: 1, from: 'server' }));
}
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
// Rally Kart best stage times: "map:stage" -> Map(pid -> { n, t, k }). Saved to disk; players also re-send their own
// bests when they connect, so the board survives a wiped disk.
const RTIMES = new Map(), RT_FILE = path.join(__dirname, 'data', 'rally.json'), RT_KEY = /^rally(-[a-z]+)?:[0-2]$/, RT_MAP = /^rally(-[a-z]+)?$/;
let rtDirty = false;
const rtName = n => String(n || 'Racer').replace(/[\u0000-\u001f]/g, '').slice(0, 14) || 'Racer', rtKart = k => /^[a-z0-9]{1,16}$/.test(String(k || '')) ? String(k) : 'classic';
function rtAdd(pid, key, time, n, k) {
  const tm = Math.round(+time * 100) / 100;
  if (!PID_RE.test(pid) || !RT_KEY.test(key) || !(tm >= 15 && tm < 900)) return false;
  let m = RTIMES.get(key); if (!m) RTIMES.set(key, m = new Map());
  const cur = m.get(pid);
  if (cur && cur.t <= tm) { if (cur.n !== n) { cur.n = n; rtDirty = true; } return false; }
  m.set(pid, { n, t: tm, k }); rtDirty = true;
  if (m.size > 600) for (const [p] of [...m.entries()].sort((a, b) => a[1].t - b[1].t).slice(500)) m.delete(p);
  return true;
}
const rtTop = map => [0, 1, 2].map(i => [...(RTIMES.get(map + ':' + i) || new Map()).entries()].map(([pid, v]) => ({ pid, n: v.n, t: v.t, k: v.k })).sort((a, b) => a.t - b.t).slice(0, 25));
try { for (const [key, list] of Object.entries(JSON.parse(fs.readFileSync(RT_FILE, 'utf8')))) if (RT_KEY.test(key) && Array.isArray(list)) for (const e of list) if (e) rtAdd(String(e.pid), key, e.t, rtName(e.n), rtKart(e.k)); } catch {}
rtDirty = false;
setInterval(() => { if (!rtDirty) return; rtDirty = false; try { fs.mkdirSync(path.dirname(RT_FILE), { recursive: true }); fs.writeFileSync(RT_FILE, JSON.stringify(Object.fromEntries([...RTIMES].map(([k, m]) => [k, [...m].map(([pid, v]) => ({ pid, ...v }))])))); } catch {} }, 15000);
// Player profiles (look + stats). Each player re-uploads their own whenever they connect.
const PROF = new Map();
const STAT_KEYS = ['k', 'd', 'w', 'bk', 'inf', 'gp', 'pt', 'ch', 'bw', 'bs', 'br', 'mp', 'gs', 'tr'];
function cleanProfile(p) {
  if (!p || typeof p !== 'object') return null;
  const num = v => Math.max(0, Math.min(1e9, Math.floor(+v || 0)));
  const str = (v, n) => String(v || '').replace(/[\u0000-\u001f]/g, '').slice(0, n);
  const st = p.st && typeof p.st === 'object' ? p.st : {};
  return { n: str(p.n, 14) || 'Pilot', h: num(p.h) % 360, sk: str(p.sk, 16), fn: str(p.fn, 16), ht: str(p.ht, 16), pt: str(p.pt, 12), cl: str(p.cl, 12),
    st: Object.fromEntries(STAT_KEYS.map(k => [k, num(st[k])])), since: Math.max(0, Math.min(Date.now(), Math.floor(+p.since || 0))),
    // what they own (so friends can gift and trade) and their player card
    inv: Array.isArray(p.inv) ? p.inv.filter(x => typeof x === 'string' && /^(suit|hat|finish|pet|emote|spray):[a-z0-9]{1,24}$/.test(x)).slice(0, 400) : [],
    cd: p.cd && typeof p.cd === 'object' ? { t: str(p.cd.t, 12).replace(/[^a-z]/g, ''), b: Math.min(30, num(p.cd.b)) } : null };
}
const seen = new Map();  // player ID -> { name, last, room } for the /players lookup page
// ---------- community maps ----------
// Published maps live in memory and in data/maps.json (best effort; free hosts can wipe the disk). Creators' browsers keep
// their own maps too and quietly re-publish any the server has lost.
const CMAPS = new Map(), MAPS_FILE = path.join(__dirname, 'data', 'maps.json');
try { for (const m of JSON.parse(fs.readFileSync(MAPS_FILE, 'utf8'))) if (m && /^c-[a-z0-9]{4,16}$/.test(m.id)) CMAPS.set(m.id, m); } catch {}
let mapsDirty = false;
setInterval(() => { if (!mapsDirty) return; mapsDirty = false; try { fs.mkdirSync(path.dirname(MAPS_FILE), { recursive: true }); fs.writeFileSync(MAPS_FILE, JSON.stringify([...CMAPS.values()])); } catch {} }, 15000);
const MAP_THEMES = ['prism', 'frost', 'haunted', 'xmas', 'valentine', 'easter', 'summer', 'harvest', 'heritage', 'pride'];
const MAP_TYPES = new Set(['box', 'cyl', 'ramp', 'ball', 'neon', 'pad', 'crate', 'barrel', 'rock', 'lamp', 'crystal', 'tree', 'pumpkin', 'tomb', 'deadtree', 'xtree', 'present', 'cane', 'snowman', 'heart', 'rosebush', 'egg', 'bush', 'palm', 'umbrella', 'castle', 'hay', 'autumn', 'harvpump', 'torch', 'baobab', 'flag', 'arch']);
function cleanMapObjs(list) {
  const out = []; if (!Array.isArray(list)) return out;
  const n = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round((+v || 0) * 100) / 100));
  for (const o of list.slice(0, 300)) {
    if (!Array.isArray(o) || !MAP_TYPES.has(o[0])) continue;
    out.push([o[0], n(o[1], -58, 58), n(o[2], 0, 40), n(o[3], -58, 58), (o[4] | 0) & 3, n(o[5] || 1, 0.3, 40), n(o[6] || 1, 0.1, 30), n(o[7] || 1, 0.3, 40), Math.max(0, Math.min(15, o[8] | 0))]);
  }
  return out;
}
const mapSummary = m => ({ id: m.id, name: m.name, author: m.author, theme: m.theme, n: m.objs.length, plays: m.plays || 0, ts: m.ts });
function newMapId() { let id; do { id = 'c-' + crypto.randomBytes(4).toString('hex').slice(0, 6); } while (CMAPS.has(id)); return id; }
function mapsPage() {
  const rows = [...CMAPS.values()].sort((a, b) => b.ts - a.ts).map(m => `<tr><td>${esc(m.name)}</td><td>${esc(m.author)}</td><td><code>${esc(m.id)}</code></td><td><code>${esc(m.pid)}</code></td><td>${m.objs.length}</td><td>${m.plays || 0}</td><td>${new Date(m.ts).toLocaleString()}</td><td><a href="/maps/${esc(m.id)}.json">data</a></td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>Prism Arena · community maps</title><style>body{font:14px system-ui;background:#0e0b1e;color:#eee;padding:20px}table{border-collapse:collapse}td,th{padding:6px 10px;border-bottom:1px solid #333;text-align:left}code{color:#5ff2ff}a{color:#ffbf6b}</style><h1>Community maps (${CMAPS.size})</h1><p>To make one official, send its map ID (or its data link) to whoever runs the game.</p><table><tr><th>Name</th><th>By</th><th>Map ID</th><th>Player ID</th><th>Objects</th><th>Plays</th><th>Published</th><th></th></tr>${rows}</table>`;
}
// ---------- clans ----------
// Kept in memory and in data/clans.json (best effort, like the maps).
const CLANS = new Map(), CLANS_FILE = path.join(__dirname, 'data', 'clans.json'), clanOfPid = new Map(), CLAN_MAX = 30;
try { for (const c of JSON.parse(fs.readFileSync(CLANS_FILE, 'utf8'))) if (c && /^[A-Z0-9]{2,5}$/.test(c.tag) && Array.isArray(c.members) && c.members.length) { CLANS.set(c.tag, c); for (const p of c.members) clanOfPid.set(p, c.tag); } } catch {}
let clansDirty = false;
setInterval(() => { if (!clansDirty) return; clansDirty = false; try { fs.mkdirSync(path.dirname(CLANS_FILE), { recursive: true }); fs.writeFileSync(CLANS_FILE, JSON.stringify([...CLANS.values()])); } catch {} }, 15000);
const clanName = pid => PROF.get(pid)?.n || seen.get(pid)?.name || '';
const clanView = c => c ? { tag: c.tag, name: c.name, owner: c.owner, wins: c.wins || 0, members: c.members.map(pid => ({ pid, n: clanName(pid), on: byPid.has(pid), w: (c.mw && c.mw[pid]) || 0 })) } : null;
function clanPush(c, extra = {}) { const msg = JSON.stringify({ t: 'clan', c: clanView(c), ...extra }); for (const pid of c.members) for (const o of byPid.get(pid) || []) send(o.ws, msg); }
function clanSay(c, n, text) { const msg = JSON.stringify({ t: 'clanmsg', n, text }); for (const pid of c.members) for (const o of byPid.get(pid) || []) send(o.ws, msg); }
const clanTopList = () => [...CLANS.values()].sort((a, b) => (b.wins || 0) - (a.wins || 0) || b.members.length - a.members.length).slice(0, 20).map(c => ({ tag: c.tag, name: c.name, wins: c.wins || 0, n: c.members.length }));
function clanMessage(client, m) {
  const pid = client.pid, reply = o => send(client.ws, JSON.stringify(o)), mine = CLANS.get(clanOfPid.get(pid));
  const str = (v, n) => String(v || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
  if (m.op === 'get') { reply({ t: 'clan', c: clanView(mine) }); reply({ t: 'clantop', list: clanTopList() }); }
  else if (m.op === 'top') reply({ t: 'clantop', list: clanTopList() });
  else if (m.op === 'create') {
    if (mine) return reply({ t: 'clan', c: clanView(mine), err: 'Leave your clan first' });
    const tag = String(m.tag || '').toUpperCase().replace(/[^A-Z0-9]/g, ''), name = str(m.name, 24);
    if (tag.length < 2 || tag.length > 5) return reply({ t: 'clan', c: null, err: 'Tags are 2 to 5 letters or numbers' });
    if (name.length < 3) return reply({ t: 'clan', c: null, err: 'Give your clan a name (at least 3 characters)' });
    if (CLANS.has(tag)) return reply({ t: 'clan', c: null, err: 'That tag is taken' });
    const c = { tag, name, owner: pid, members: [pid], wins: 0, mw: {}, ts: Date.now() };
    CLANS.set(tag, c); clanOfPid.set(pid, tag); clansDirty = true;
    clanPush(c, { ok: `You started [${tag}] ${name}` });
  } else if (m.op === 'join') {
    if (mine) return reply({ t: 'clan', c: clanView(mine), err: 'Leave your clan first' });
    const c = CLANS.get(String(m.tag || '').toUpperCase());
    if (!c) return reply({ t: 'clan', c: null, err: 'No clan has that tag' });
    if (c.members.length >= CLAN_MAX) return reply({ t: 'clan', c: null, err: 'That clan is full' });
    c.members.push(pid); clanOfPid.set(pid, c.tag); clansDirty = true;
    clanPush(c); reply({ t: 'clan', c: clanView(c), ok: `You joined [${c.tag}] ${c.name}` }); clanSay(c, 'CLAN', `${clanName(pid) || 'Someone'} joined the clan`);
  } else if (m.op === 'leave' && mine) {
    mine.members = mine.members.filter(p => p !== pid); clanOfPid.delete(pid);
    if (mine.owner === pid) mine.owner = mine.members[0] || '';
    if (!mine.members.length) CLANS.delete(mine.tag); else { clanPush(mine); clanSay(mine, 'CLAN', `${clanName(pid) || 'Someone'} left the clan`); }
    clansDirty = true; reply({ t: 'clan', c: null, ok: 'You left the clan' });
  } else if (m.op === 'kick' && mine && mine.owner === pid && typeof m.pid === 'string' && m.pid !== pid && mine.members.includes(m.pid)) {
    mine.members = mine.members.filter(p => p !== m.pid); clanOfPid.delete(m.pid); clansDirty = true;
    for (const o of byPid.get(m.pid) || []) send(o.ws, JSON.stringify({ t: 'clan', c: null, err: 'You were removed from the clan' }));
    clanPush(mine);
  } else if (m.op === 'chat' && mine) {
    const now = Date.now(); if (now - (client.clanT || 0) < 700) return; client.clanT = now;
    const text = str(m.text, 120); if (text) clanSay(mine, str(m.n, 14) || clanName(pid) || 'Pilot', text);
  } else if (m.op === 'win' && mine) {
    // a member won a PvP match (rate limited per connection)
    const now = Date.now(); if (now - (client.winT || 0) < 20000) return; client.winT = now;
    mine.wins = (mine.wins || 0) + 1; mine.mw = mine.mw || {}; mine.mw[pid] = (mine.mw[pid] || 0) + 1; clansDirty = true; clanPush(mine);
  }
}
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
    '<meta name="description" content="Prism Arena: a first-person sky arena shooter. Battle Royale, Squad Waves, Boss Raid, Free-for-All, Gun Game, Infection, Prop Hunt and more.">' +
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
  } else if (url === '/maps') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(mapsPage());
  } else if (/^\/maps\/c-[a-z0-9]{4,16}\.json$/.test(url) && CMAPS.has(url.slice(6, -5))) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(CMAPS.get(url.slice(6, -5))));
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
      sendGifts(client);
      { const g = groupOf(m.pid); if (g) send(ws, JSON.stringify({ t: 'linked', main: g[0], g, sig: linkSig(g) })); }
    } else if (m.t === 'mappub' && client.pid && m.map && typeof m.map === 'object') {
      const mm = m.map, objs = cleanMapObjs(mm.objs), name = String(mm.name || '').replace(/[ -]/g, '').trim().slice(0, 24);
      if (name.length < 3 || objs.length < 5) { send(ws, JSON.stringify({ t: 'maperr', msg: 'Maps need a name and at least 5 things' })); return; }
      const old = /^c-[a-z0-9]{4,16}$/.test(mm.id || '') ? CMAPS.get(mm.id) : null;
      if (old && !sameGroup(old.pid, client.pid)) { send(ws, JSON.stringify({ t: 'maperr', msg: 'That map belongs to someone else' })); return; }
      // restoring a map the server forgot keeps its old ID
      const id = old ? old.id : m.restore && /^c-[a-z0-9]{4,16}$/.test(mm.id || '') ? mm.id : newMapId();
      if (!old && [...CMAPS.values()].filter(x => sameGroup(x.pid, client.pid)).length >= 20) { send(ws, JSON.stringify({ t: 'maperr', msg: 'You can publish up to 20 maps. Delete one first.' })); return; }
      const map = { id, name, author: String(mm.author || 'Pilot').replace(/[ -]/g, '').slice(0, 14), pid: client.pid, theme: MAP_THEMES.includes(mm.theme) ? mm.theme : 'prism', objs, ts: old ? old.ts : Date.now(), plays: old ? old.plays || 0 : +mm.plays || 0 };
      CMAPS.set(id, map); mapsDirty = true;
      if (!m.restore) send(ws, JSON.stringify({ t: 'mappubok', map }));
    } else if (m.t === 'maplist') {
      send(ws, JSON.stringify({ t: 'maplist', list: [...CMAPS.values()].sort((a, b) => b.ts - a.ts).slice(0, 200).map(mapSummary) }));
    } else if (m.t === 'mapget' && typeof m.id === 'string') {
      const map = CMAPS.get(m.id); send(ws, JSON.stringify(map ? { t: 'mapdata', map } : { t: 'mapdata', id: m.id, missing: 1 }));
    } else if (m.t === 'mapdel' && client.pid && typeof m.id === 'string') {
      const map = CMAPS.get(m.id); if (map && sameGroup(map.pid, client.pid)) { CMAPS.delete(m.id); mapsDirty = true; }
    } else if (m.t === 'mapplay' && typeof m.id === 'string') {
      const map = CMAPS.get(m.id); client.played = client.played || new Set();
      if (map && !client.played.has(m.id)) { client.played.add(m.id); map.plays = (map.plays || 0) + 1; mapsDirty = true; }
    } else if (m.t === 'mapmine' && client.pid && Array.isArray(m.ids)) {
      send(ws, JSON.stringify({ t: 'mapneed', ids: m.ids.slice(0, 20).filter(id => typeof id === 'string' && /^c-[a-z0-9]{4,16}$/.test(id) && !CMAPS.has(id)) }));
    } else if (/^(gift|giftack|trade|tradeacc|tradedone|tradeno)$/.test(m.t) && client.pid && typeof m.to === 'string' && PID_RE.test(m.to)) {
      // gifts and trades go to one of the other player's devices; their game does the checking
      if (m.t === 'gift' && !(typeof m.item === 'string' && ITEM_RE.test(m.item))) return;
      const strs = l => Array.isArray(l) ? l.filter(x => typeof x === 'string' && ITEM_RE.test(x)).slice(0, 6) : [];
      const out = { t: m.t, from: client.pid, id: String(m.id || '').slice(0, 60), n: String(m.n || '').replace(/[ -]/g, '').slice(0, 14) };
      if (m.t === 'gift') out.item = m.item;
      if (m.t === 'trade') { out.give = strs(m.give); out.want = strs(m.want); }
      if (m.t === 'tradedone') out.ok = m.ok ? 1 : 0;
      const to = clientFor(m.to); if (to) send(to.ws, JSON.stringify(out));
    } else if (m.t === 'clan' && client.pid) {
      clanMessage(client, m);
    } else if (m.t === 'link' && client.pid) {
      linkMessage(client, m);
    } else if (m.t === 'wal' && client.pid) {
      walMessage(client, m);
    } else if (m.t === 'pay' && client.pid && typeof m.id === 'string' && m.id.length < 80) {
      // route a creator-code payout to the creator's player ID if they're online; the buyer retries until acked
      const target = CREATORS[String(m.code || '').toUpperCase()];
      if (!target) return;
      if (sameGroup(target, client.pid)) { send(ws, JSON.stringify({ t: 'ack', id: m.id })); return; }
      const amount = Math.max(0, Math.min(500, Math.floor(+m.amount || 0)));
      const msg = JSON.stringify({ t: 'pay', id: m.id, amount, code: String(m.code).toUpperCase(), from: client.pid });
      // one device only (any of the creator's linked IDs), so a payout is never credited twice
      const to = clientFor(target); if (to) send(to.ws, msg);
    } else if (m.t === 'lb' && client.pid) {
      // older pages send no board name: that's the Squad Waves board, and they only get that board back
      const board = BOARDS[m.board] ? m.board : 'waves';
      lbMerge(client, m.entries, BOARDS[board]);
      send(ws, JSON.stringify({ t: 'lbtop', board, list: lbTop(BOARDS[board]) }));
    } else if (m.t === 'rt' && client.pid && typeof m.key === 'string') {
      rtAdd(client.pid, m.key, m.time, rtName(m.n), rtKart(m.k));
      const map = m.key.split(':')[0]; if (RT_MAP.test(map)) send(ws, JSON.stringify({ t: 'rtop', map, st: rtTop(map) }));
    } else if (m.t === 'rtall' && client.pid && Array.isArray(m.list)) {
      for (const e of m.list.slice(0, 40)) if (Array.isArray(e) && typeof e[0] === 'string') rtAdd(client.pid, e[0], e[1], rtName(m.n), rtKart(m.k));
    } else if (m.t === 'rtget' && typeof m.map === 'string' && RT_MAP.test(m.map)) {
      send(ws, JSON.stringify({ t: 'rtop', map: m.map, st: rtTop(m.map) }));
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
      const msg = JSON.stringify({ t: 'invite', from: client.pid, n: String(m.n || '').replace(/[\u0000-\u001f]/g, '').slice(0, 14), mode: str(m.mode, 10), map: str(m.map, 20), room: str(m.room, 20).toLowerCase() });
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
      if (r.size >= roomCap(name)) { send(ws, JSON.stringify({ t: 'full' })); return; }
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
