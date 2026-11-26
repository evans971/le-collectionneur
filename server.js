// Le Collectionneur — serveur de jeu (salons en temps réel + classement)
// Lancer : npm install puis npm start  →  http://localhost:3000
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'scores.json');
const DATABASE_URL = process.env.DATABASE_URL || '';

// ---------------------------------------------------------------- scores
const CHARS = ['nadia', 'marcus', 'lea', 'okafor', 'victor', 'ines', 'rosa', 'sam'];
const MODES = ['solo', 'friend', 'online'];
const cleanName = s => String(s == null ? '' : s).replace(/[^\p{L}\p{N} _.\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16);
function cleanScore(d) {
  if (!d || typeof d !== 'object') return null;
  const score = Math.round(+d.score);
  if (!Number.isFinite(score) || score < 0 || score > 20000) return null;
  return {
    name: cleanName(d.name) || 'Anonyme',
    score,
    day: Math.min(5, Math.max(1, Math.round(+d.day) || 1)),
    win: !!d.win,
    char: CHARS.includes(d.char) ? d.char : 'nadia',
    mode: MODES.includes(d.mode) ? d.mode : 'solo',
    at: Date.now(),
  };
}
const idOk = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{6,64}$/.test(id);

// Stockage : Postgres si DATABASE_URL est défini, sinon un fichier JSON.
let store;
if (DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false } });
  const ready = pool.query('CREATE TABLE IF NOT EXISTS scores (id TEXT PRIMARY KEY, score INTEGER NOT NULL, data JSONB NOT NULL)');
  store = {
    kind: 'postgres',
    async get(id) { await ready; const r = await pool.query('SELECT data FROM scores WHERE id=$1', [id]); return r.rows[0] ? r.rows[0].data : null; },
    async put(id, data) { await ready; await pool.query('INSERT INTO scores (id, score, data) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET score=EXCLUDED.score, data=EXCLUDED.data', [id, data.score, data]); },
    async top(n) { await ready; const r = await pool.query('SELECT data FROM scores ORDER BY score DESC LIMIT $1', [n]); return r.rows.map(x => x.data); },
  };
} else {
  let db = {};
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {}; } catch (e) { db = {}; }
  let saveT = null;
  const save = () => {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); }
      catch (e) { console.error('Sauvegarde impossible :', e.message); }
    }, 500);
  };
  store = {
    kind: 'fichier',
    async get(id) { return db[id] || null; },
    async put(id, data) { db[id] = data; save(); },
    async top(n) { return Object.values(db).sort((a, b) => b.score - a.score).slice(0, n); },
  };
}
async function submit(id, raw) {
  const e = cleanScore(raw);
  if (!e) throw new Error('score invalide');
  const old = await store.get(id);
  const games = ((old && +old.games) || 0) + 1;
  const best = !old || e.score > +old.score ? { ...e, games } : { ...old, name: e.name, games };
  await store.put(id, best);
  return best;
}

// ---------------------------------------------------------------- fichiers
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  let file = path.normalize(path.join(PUBLIC, url === '/' ? 'index.html' : url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Introuvable'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
    res.end(buf);
  });
});

// ---------------------------------------------------------------- salons
const rooms = new Map(); // nom -> Map(peer -> {ws, p})
const ROOM_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const bcT = new Map();
function snapshot(name) { const r = rooms.get(name); return r ? [...r].map(([peer, m]) => ({ peer, p: m.p })) : []; }
function broadcast(name) {
  if (bcT.has(name)) return;
  bcT.set(name, setTimeout(() => {
    bcT.delete(name);
    const r = rooms.get(name); if (!r) return;
    const msg = JSON.stringify({ t: 'peers', room: name, list: snapshot(name) });
    for (const m of r.values()) if (m.ws.readyState === 1) m.ws.send(msg);
  }, 50));
}
function leave(ws, name) {
  const r = rooms.get(name); if (!r) return;
  const m = r.get(ws.peer);
  if (m && m.ws === ws) { r.delete(ws.peer); if (!r.size) rooms.delete(name); else broadcast(name); }
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const sid = q.get('sid') || '';
  ws.peer = /^[a-z0-9]{6,24}$/.test(sid) ? sid : Math.random().toString(36).slice(2, 12);
  ws.rooms = new Set();
  ws.alive = true;
  ws.budget = 60;
  ws.on('pong', () => { ws.alive = true; });
  ws.send(JSON.stringify({ t: 'hello', peer: ws.peer, storage: store.kind }));
  ws.on('message', async raw => {
    if (--ws.budget < 0) return; // anti-flood
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const reply = (data, err) => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'res', rid: m.rid, data, err }));
    try {
      if (m.t === 'join' && ROOM_RE.test(m.room)) {
        if (ws.rooms.size >= 16) return reply(null, 'limit_reached');
        let r = rooms.get(m.room); if (!r) { r = new Map(); rooms.set(m.room, r); }
        if (r.size >= 64 && !r.has(ws.peer)) return reply(null, 'limit_reached');
        const prev = r.get(ws.peer);
        r.set(ws.peer, { ws, p: (prev && prev.p) || {} });
        ws.rooms.add(m.room); broadcast(m.room); reply(true);
      } else if (m.t === 'leave' && typeof m.room === 'string') {
        leave(ws, m.room); ws.rooms.delete(m.room); reply(true);
      } else if (m.t === 'pres' && ws.rooms.has(m.room) && m.p && typeof m.p === 'object' && JSON.stringify(m.p).length <= 4096) {
        const r = rooms.get(m.room); const me = r && r.get(ws.peer);
        if (me && me.ws === ws) { me.p = m.p; broadcast(m.room); }
      } else if (m.t === 'top') {
        reply(await store.top(Math.min(100, +m.n || 50)));
      } else if (m.t === 'get' && idOk(m.id)) {
        reply(await store.get(m.id));
      } else if (m.t === 'set' && idOk(m.id)) {
        reply(await submit(m.id, m.data));
      }
    } catch (e) { reply(null, String(e.message || e)); }
  });
  ws.on('close', () => { for (const name of ws.rooms) leave(ws, name); ws.rooms.clear(); });
});
setInterval(() => { for (const ws of wss.clients) ws.budget = 60; }, 1000);
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch (e) {} }
}, 20000);

server.listen(PORT, () => console.log(`Le Collectionneur : http://localhost:${PORT}  (classement : ${store.kind})`));
