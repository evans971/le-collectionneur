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
  const ready = pool.query('CREATE TABLE IF NOT EXISTS scores (id TEXT PRIMARY KEY, score INTEGER NOT NULL, data JSONB NOT NULL)').then(() => pool.query('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v JSONB NOT NULL)'));
  store = {
    kind: 'postgres',
    async get(id) { await ready; const r = await pool.query('SELECT data FROM scores WHERE id=$1', [id]); return r.rows[0] ? r.rows[0].data : null; },
    async put(id, data) { await ready; await pool.query('INSERT INTO scores (id, score, data) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET score=EXCLUDED.score, data=EXCLUDED.data', [id, data.score, data]); },
    async top(n) { await ready; const r = await pool.query('SELECT data FROM scores ORDER BY score DESC LIMIT $1', [n]); return r.rows.map(x => x.data); },
    async kget(k) { await ready; const r = await pool.query('SELECT v FROM kv WHERE k=$1', [k]); return r.rows[0] ? r.rows[0].v : null; },
    async kset(k, v) { await ready; await pool.query('INSERT INTO kv (k, v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v', [k, JSON.stringify(v)]); },
    async kdel(k) { await ready; await pool.query('DELETE FROM kv WHERE k=$1', [k]); },
  };
} else {
  let db = {};
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {}; } catch (e) { db = {}; }
  Object.defineProperty(db, '__kv', { value: db.__kv || {}, writable: true, enumerable: false });
  let saveT = null;
  const save = () => {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify({ ...db, __kv: db.__kv })); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); }
      catch (e) { console.error('Sauvegarde impossible :', e.message); }
    }, 500);
  };
  store = {
    kind: 'fichier',
    async get(id) { return db[id] || null; },
    async put(id, data) { db[id] = data; save(); },
    async top(n) { return Object.values(db).filter(x => x && typeof x.score === 'number').sort((a, b) => b.score - a.score).slice(0, n); },
    async kget(k) { return (db.__kv && db.__kv[k]) || null; },
    async kset(k, v) { db.__kv = db.__kv || {}; db.__kv[k] = v; save(); },
    async kdel(k) { if (db.__kv) { delete db.__kv[k]; save(); } },
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


// ---------------------------------------------------------------- comptes
const crypto = require('crypto');
const PRICES = { ines: 300, rosa: 400, sam: 500 };
const ITEMS = { leurre: 20, petard: 20, fumigene: 20 };
const ACH_IDS = /^[a-z0-9]{2,20}$/;
const hashPass = (pass, salt) => crypto.scryptSync(String(pass), salt, 32).toString('hex');
const locks = new Map();
function withLock(id, fn) { const prev = locks.get(id) || Promise.resolve(); const next = prev.then(fn, fn); locks.set(id, next.catch(() => {})); return next; }
function profile(a) { return { name: a.name, coins: a.coins, owned: a.owned, stock: a.stock, ach: a.ach, cnt: a.cnt, best: a.best || 0, games: a.games || 0 }; }
async function newSession(id) { const token = crypto.randomBytes(24).toString('hex'); await store.kset('sess:' + token, { id, at: Date.now() }); return token; }
async function accFromToken(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) throw new Error('session');
  const s = await store.kget('sess:' + token); if (!s) throw new Error('session');
  const a = await store.kget('acc:' + s.id); if (!a) throw new Error('session');
  return a;
}
function importLocal(a, loc) {
  if (!loc || typeof loc !== 'object') return;
  a.coins = Math.min(3000, Math.max(0, Math.floor(+loc.coins) || 0));
  if (Array.isArray(loc.owned)) a.owned = loc.owned.filter(x => PRICES[x]).slice(0, 10);
  if (loc.stock && typeof loc.stock === 'object') for (const k in ITEMS) a.stock[k] = Math.min(20, Math.max(0, Math.floor(+loc.stock[k]) || 0));
  mergeMeta(a, loc.ach, loc.cnt);
}
function mergeMeta(a, ach, cnt) {
  if (ach && typeof ach === 'object') for (const k of Object.keys(ach).slice(0, 60)) if (ACH_IDS.test(k) && !a.ach[k]) a.ach[k] = Date.now();
  if (cnt && typeof cnt === 'object') for (const k of ['missions', 'crates']) { const v = Math.floor(+cnt[k]) || 0; if (v > (a.cnt[k] || 0)) a.cnt[k] = Math.min(v, (a.cnt[k] || 0) + 500); }
}
const accounts = {
  async register(name, pass, loc) {
    name = cleanName(name); if (name.length < 3) throw new Error('Pseudo trop court (3 caractères minimum).');
    if (typeof pass !== 'string' || pass.length < 6 || pass.length > 100) throw new Error('Mot de passe : 6 caractères minimum.');
    const key = 'name:' + name.toLowerCase();
    return withLock(key, async () => {
      if (await store.kget(key)) throw new Error('Ce pseudo est déjà pris.');
      const id = 'a' + crypto.randomBytes(9).toString('hex'), salt = crypto.randomBytes(16).toString('hex');
      const a = { id, name, salt, hash: hashPass(pass, salt), coins: 0, owned: [], stock: { leurre: 0, petard: 0, fumigene: 0 }, ach: {}, cnt: { missions: 0, crates: 0 }, created: Date.now() };
      importLocal(a, loc);
      await store.kset('acc:' + id, a); await store.kset(key, { id });
      return { token: await newSession(id), profile: profile(a) };
    });
  },
  async login(name, pass) {
    const n = await store.kget('name:' + cleanName(name).toLowerCase());
    const a = n && await store.kget('acc:' + n.id);
    if (!a || hashPass(pass, a.salt) !== a.hash) throw new Error('Pseudo ou mot de passe incorrect.');
    return { token: await newSession(a.id), profile: profile(a) };
  },
  async auth(token) { return profile(await accFromToken(token)); },
  async logout(token) { if (typeof token === 'string' && /^[a-f0-9]{48}$/.test(token)) await store.kdel('sess:' + token); return true; },
  async op(token, fn) { const a0 = await accFromToken(token); return withLock(a0.id, async () => { const a = await store.kget('acc:' + a0.id); const r = await fn(a); await store.kset('acc:' + a.id, a); return r || profile(a); }); },
};
async function award(token, d) {
  return accounts.op(token, async a => {
    const e = cleanScore({ ...d, name: a.name }); if (!e) throw new Error('score invalide');
    const gain = Math.floor(e.score / 10);
    a.coins += gain; a.games = (a.games || 0) + 1; if (e.score > (a.best || 0)) a.best = e.score;
    await submit('a_' + a.id, e);
    return { ...profile(a), gain };
  });
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
      } else if (m.t === 'register') {
        if ((ws.authTries = (ws.authTries || 0) + 1) > 20) return reply(null, 'Trop d\'essais, recharge la page.');
        reply(await accounts.register(m.name, m.pass, m.local));
      } else if (m.t === 'login') {
        if ((ws.authTries = (ws.authTries || 0) + 1) > 20) return reply(null, 'Trop d\'essais, recharge la page.');
        reply(await accounts.login(m.name, m.pass));
      } else if (m.t === 'auth') {
        reply(await accounts.auth(m.token));
      } else if (m.t === 'logout') {
        reply(await accounts.logout(m.token));
      } else if (m.t === 'award') {
        reply(await award(m.token, m.data));
      } else if (m.t === 'buy') {
        reply(await accounts.op(m.token, async a => {
          if (PRICES[m.item]) { if (a.owned.includes(m.item)) return; if (a.coins < PRICES[m.item]) throw new Error('Pas assez de pièces.'); a.coins -= PRICES[m.item]; a.owned.push(m.item); }
          else if (ITEMS[m.item]) { if (a.coins < ITEMS[m.item]) throw new Error('Pas assez de pièces.'); a.coins -= ITEMS[m.item]; a.stock[m.item] = (a.stock[m.item] || 0) + 1; }
          else throw new Error('Article inconnu.');
        }));
      } else if (m.t === 'use' && ITEMS[m.item]) {
        reply(await accounts.op(m.token, async a => { if ((a.stock[m.item] || 0) > 0) a.stock[m.item]--; }));
      } else if (m.t === 'meta') {
        reply(await accounts.op(m.token, async a => { mergeMeta(a, m.ach, m.cnt); }));
      }
    } catch (e) { reply(null, String(e.message || e)); }
  });
  ws.on('close', () => { for (const name of ws.rooms) leave(ws, name); ws.rooms.clear(); });
});
setInterval(() => { for (const ws of wss.clients) ws.budget = 60; }, 1000);
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch (e) {} }
}, 20000);

server.listen(PORT, () => console.log(`Le Collectionneur : http://localhost:${PORT}  (stockage : ${store.kind})`));
