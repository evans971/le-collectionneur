// Connexion au serveur du jeu : salons en temps réel et classement.
// Si le jeu est hébergé ailleurs que le serveur (itch.io par exemple),
// mets l'adresse du serveur dans config.js.
(function () {
  'use strict';
  const base = (window.GAME_SERVER || location.origin).replace(/\/+$/, '');
  const WS_URL = base.replace(/^http/, 'ws') + '/ws';
  const sid = Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 6);
  const uid = (() => {
    try { let u = localStorage.getItem('collectionneur_uid'); if (!u) { u = 'u' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('collectionneur_uid', u); } return u; }
    catch (e) { return 'u' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
  })();
  let ws = null, open = false, rid = 0, tries = 0;
  const waiters = [], pending = new Map(), rooms = new Map();
  const err = code => ({ code, message: code });

  function connect() {
    try { ws = new WebSocket(WS_URL + '?sid=' + sid); } catch (e) { setTimeout(connect, 3000); return; }
    ws.onopen = () => {
      open = true; tries = 0;
      for (const r of rooms.values()) { raw({ t: 'join', room: r.name }); raw({ t: 'pres', room: r.name, p: r.mine }); }
      waiters.splice(0).forEach(f => f(true));
    };
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.t === 'peers') { const r = rooms.get(m.room); if (r) { r.list = Array.isArray(m.list) ? m.list : []; r.emit(); } }
      else if (m.t === 'res') { const p = pending.get(m.rid); if (p) { pending.delete(m.rid); clearTimeout(p.to); m.err ? p.rej(err(m.err)) : p.res(m.data); } }
    };
    ws.onclose = () => {
      open = false;
      for (const [k, p] of pending) { clearTimeout(p.to); p.rej(err('upstream_error')); pending.delete(k); }
      setTimeout(connect, Math.min(8000, 1000 * (++tries)));
    };
    ws.onerror = () => {};
  }
  const raw = m => { if (open && ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
  const waitOpen = ms => open ? Promise.resolve(true) : new Promise(res => { waiters.push(res); setTimeout(() => res(open), ms); });
  async function call(m, ms = 10000) {
    if (!await waitOpen(8000)) throw err('upstream_error');
    return new Promise((res, rej) => {
      const id = ++rid; m.rid = id;
      pending.set(id, { res, rej, to: setTimeout(() => { pending.delete(id); rej(err('upstream_error')); }, ms) });
      raw(m);
    });
  }

  function makeRoom(name) {
    const r = { name, mine: {}, list: [], subs: new Set(), left: false, t: null, snap: null };
    r.emit = () => { r.snap = null; const ps = api.peers(); for (const f of r.subs) { try { f({ peers: ps, joined: [], left: [], updated: [] }); } catch (e) { console.error(e); } } };
    const api = {
      name,
      presence(patch) {
        if (r.left) return Promise.reject(err('invalid_argument'));
        const next = { ...r.mine };
        for (const k in patch) { if (patch[k] === null) delete next[k]; else next[k] = JSON.parse(JSON.stringify(patch[k])); }
        if (JSON.stringify(next).length > 4096) return Promise.reject(err('invalid_argument'));
        r.mine = next; r.snap = null;
        if (!r.t) r.t = setTimeout(() => { r.t = null; raw({ t: 'pres', room: name, p: r.mine }); }, 80);
        r.emit();
        return Promise.resolve();
      },
      peers() {
        if (r.snap) return r.snap;
        const out = []; let me = false;
        for (const x of r.list) {
          if (!x || typeof x.peer !== 'string') continue;
          const isMe = x.peer === sid; if (isMe) me = true;
          out.push({ peer: x.peer, by: null, isMe, sameTab: isMe, kind: 'viewer', guest: false, presence: isMe ? r.mine : (x.p || {}), updatedAt: Date.now() });
        }
        if (!me) out.unshift({ peer: sid, by: null, isMe: true, sameTab: true, kind: 'viewer', guest: false, presence: r.mine, updatedAt: Date.now() });
        return (r.snap = out);
      },
      onPeers(fn) { r.subs.add(fn); setTimeout(() => { if (r.subs.has(fn)) fn({ peers: api.peers(), joined: [], left: [], updated: [] }); }, 0); return () => r.subs.delete(fn); },
      async leave() { if (r.left) return; r.left = true; r.subs.clear(); rooms.delete(name); raw({ t: 'leave', room: name }); },
      connected: () => open,
      emit: async () => {}, on: () => () => {},
    };
    return { r, api };
  }

  const room = {
    async join(name) {
      if (!/^[a-z0-9][a-z0-9_.-]{0,47}$/.test(name)) throw err('invalid_argument');
      const ex = rooms.get(name); if (ex) return ex.api;
      if (!await waitOpen(8000)) throw err('upstream_error');
      const { r, api } = makeRoom(name); r.api = api; rooms.set(name, r);
      try { await call({ t: 'join', room: name }); } catch (e) { rooms.delete(name); throw e; }
      return api;
    },
    peers: () => [], connected: () => open,
  };
  const snap = d => ({ exists: !!d, data: () => d || undefined, metadata: { fromCache: false, hasPendingWrites: false } });
  const db = {
    collection(c) {
      let n = 50;
      const q = { orderBy: () => q, where: () => q, limit: k => { n = k; return q; },
        async get() { const list = c === 'scores' ? await call({ t: 'top', n }) : []; const docs = (list || []).map(snap); return { docs, size: docs.length, empty: !docs.length }; } };
      return q;
    },
    doc(p) {
      const id = String(p).split('/')[1];
      return { id, path: p, get: async () => snap(await call({ t: 'get', id })), set: async d => { await call({ t: 'set', id, data: d }); } };
    },
  };
  const user = { id: async () => uid, isOwner: async () => false, canEdit: async () => false };
  window.GAMENET = { call: (m, ms) => call(m, ms), online: () => open };
  window.claude = { use: async n => n === 'room' ? room : n === 'db' ? db : n === 'user' ? user : null };
  connect();
})();
