// Valmont: Last Door Out — serveur de jeu (salons en temps réel + classement)
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
    async klist(pre) { await ready; const r = await pool.query('SELECT k, v FROM kv WHERE k LIKE $1', [pre + '%']); return r.rows.map(x => x.v); },
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
    async klist(pre) { return Object.entries(db.__kv || {}).filter(([k]) => k.startsWith(pre)).map(([, v]) => v); },
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
    a.coins += gain; a.games = (a.games || 0) + 1;
    if (!(d && d.easy)) { if (e.score > (a.best || 0)) a.best = e.score; await submit('a_' + a.id, e); }
    return { ...profile(a), gain };
  });
}

// ---------------------------------------------------------------- avis des joueurs
const shortTag = v => String(v == null ? '' : v).replace(/[^\w.\-]/g, '').slice(0, 60);
async function saveRating(m) {
  if (!idOk(m.uid)) throw new Error('invalid');
  const stars = Math.round(+m.stars);
  if (!(stars >= 1 && stars <= 5)) throw new Error('invalid');
  const text = String(m.text == null ? '' : m.text).replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, 500);
  const prev = await store.kget('rate:' + m.uid);
  await store.kset('rate:' + m.uid, {
    stars, text, lang: shortTag(m.lang), plat: shortTag(m.plat), site: shortTag(m.site),
    day: Math.min(5, Math.max(0, Math.round(+m.day) || 0)), at: Date.now(), first: (prev && (prev.first || prev.at)) || Date.now(),
  });
  return true;
}
const escH = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function keyOk(given) {
  const want = process.env.ADMIN_KEY || '';
  const a = Buffer.from(String(given)), b = Buffer.from(want);
  return want.length >= 6 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function avisPage(req, res) {
  const send = (code, html) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }); res.end(html); };
  const head = '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Avis des joueurs · Valmont</title><style>body{font:16px/1.5 system-ui,sans-serif;background:#0f1715;color:#e8e4d8;max-width:860px;margin:0 auto;padding:28px 18px}h1{margin:0 0 4px}small,.m{color:#93a39c}.big{font-size:56px;font-weight:700;color:#f2c14e;line-height:1}.top{display:flex;gap:32px;align-items:center;flex-wrap:wrap;margin:22px 0 28px}.bars div{display:flex;align-items:center;gap:8px;font-size:14px}.bars i{display:block;height:10px;background:#f2c14e;border-radius:3px}.c{background:#17221f;border:1px solid #2a3a35;border-radius:10px;padding:12px 14px;margin:10px 0}.s{color:#f2c14e;letter-spacing:2px}.t{white-space:pre-wrap;margin-top:6px}form{margin-top:30px}input{font:inherit;padding:8px;border-radius:6px;border:1px solid #2a3a35;background:#17221f;color:inherit}button{font:inherit;padding:8px 14px;border-radius:6px;border:0;background:#e0483e;color:#fff}</style></head><body>';
  if (!process.env.ADMIN_KEY) return send(503, head + '<h1>Avis des joueurs</h1><p>Page désactivée : ajoute la variable <b>ADMIN_KEY</b> (au moins 6 caractères) dans Render → Environment, puis reviens sur <code>/avis?cle=TA_CLE</code>.</p></body></html>');
  const q = new URLSearchParams((req.url || '').split('?')[1] || '');
  if (!keyOk(q.get('cle') || '')) return send(403, head + '<h1>Avis des joueurs</h1><form method="get"><p>Entre ta clé :</p><input name="cle" type="password" autofocus> <button>Voir</button></form></body></html>');
  let list = [];
  try { list = (await store.klist('rate:')).filter(x => x && x.stars >= 1 && x.stars <= 5); } catch (e) { return send(500, head + '<p>Lecture impossible : ' + escH(e.message) + '</p></body></html>'); }
  list.sort((a, b) => b.at - a.at);
  const n = list.length, avg = n ? list.reduce((t, x) => t + x.stars, 0) / n : 0;
  const dist = [5, 4, 3, 2, 1].map(k => [k, list.filter(x => x.stars === k).length]);
  const max = Math.max(1, ...dist.map(d => d[1]));
  const site = s => /itch/.test(s) ? 'itch.io' : /poki/.test(s) ? 'Poki' : /onrender/.test(s) ? 'site' : (s || '?');
  const date = t => new Date(t).toLocaleString('fr-FR', { timeZone: 'America/Guadeloupe', dateStyle: 'short', timeStyle: 'short' });
  const stars = k => '★'.repeat(k) + '<span style="opacity:.25">' + '★'.repeat(5 - k) + '</span>';
  const withText = list.filter(x => x.text).length;
  send(200, head + `<h1>Avis des joueurs</h1><small>Valmont: Last Door Out · un avis par appareil (le plus récent compte)</small>
<div class="top"><div><div class="big">${n ? avg.toFixed(2).replace('.', ',') : '–'}</div><div class="m">sur 5 · ${n} avis · ${withText} avec un commentaire</div></div>
<div class="bars">${dist.map(([k, c]) => `<div><span class="s">${k}★</span><i style="width:${Math.round(c / max * 220)}px"></i><span class="m">${c}</span></div>`).join('')}</div></div>
${list.map(x => `<div class="c"><span class="s">${stars(x.stars)}</span> <small>${date(x.at)} · ${escH(site(x.site))} · ${escH(x.lang || '?')} · ${escH(x.plat || '?')}${x.day ? ' · jour ' + x.day : ''}</small>${x.text ? `<div class="t">${escH(x.text)}</div>` : ''}</div>`).join('') || '<p class="m">Pas encore d\'avis.</p>'}
</body></html>`);
}

// ---------------------------------------------------------------- fichiers
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/avis') { avisPage(req, res); return; }
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  let file = path.normalize(path.join(PUBLIC, url.endsWith('/') ? url + 'index.html' : url));
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
      } else if (m.t === 'rate') {
        if ((ws.rates = (ws.rates || 0) + 1) > 5) return reply(null, 'limit_reached');
        reply(await saveRating(m));
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

server.listen(PORT, () => console.log(`Valmont: Last Door Out : http://localhost:${PORT}  (stockage : ${store.kind})`));
