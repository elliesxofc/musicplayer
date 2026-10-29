'use strict';

/* Stagelight's web server: the remote panel for any browser on the same network (or through
   Tailscale), behind a password.

   - the password is stored only as a scrypt hash; logging in gives a session cookie
     (HttpOnly, SameSite=Strict) that lasts 12 hours
   - wrong passwords lock that address out: 5 tries, then 1 minute, doubling each time (to 1 hour)
   - every change goes through POST with a custom header, so other websites can't send them
   - the panel only gets OBS's state and a fixed set of actions, never the OBS password */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SESSION_MS = 12 * 3600 * 1000;
const COOKIE = 'stagelight_session';
const PANEL = path.join(__dirname, 'panel');
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/panel.css': ['panel.css', 'text/css; charset=utf-8'],
  '/panel.js': ['panel.js', 'text/javascript; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
};

/* ───────────── passwords ───────────── */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 });
  return { salt: salt.toString('base64'), hash: hash.toString('base64') };
}
function checkPassword(password, stored) {
  if (!stored || !stored.salt || !stored.hash) return false;
  const want = Buffer.from(stored.hash, 'base64');
  const got = crypto.scryptSync(String(password), Buffer.from(stored.salt, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(want, got);
}

function createServer({ obs, remote = null, getPassword, log = () => {} }) {
  const sessions = new Map(); // token → { expires, ip }
  const failures = new Map(); // ip → { count, lockedUntil, lockMs }
  const watchers = new Set(); // open event streams: { res, token }
  let server = null, port = 0;

  const ipOf = req => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(code, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      ...extra,
    });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  function sessionOf(req) {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,100})`).exec(req.headers.cookie || '');
    if (!m) return null;
    const s = sessions.get(m[1]);
    if (!s) return null;
    if (Date.now() > s.expires) { sessions.delete(m[1]); return null; }
    return { token: m[1], ...s };
  }

  function readBody(req, max = 10_000) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', c => { size += c.length; if (size > max) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('not JSON')); } });
      req.on('error', reject);
    });
  }

  // changes only from Stagelight's own panel: a custom header (which other sites can't add
  // without asking first, and Stagelight never says yes) and JSON
  const fromPanel = req => req.headers['x-stagelight'] === '1' && /^application\/json\b/.test(req.headers['content-type'] || '');

  // the password, with the lockout: null when it's right, otherwise [status, message]
  function verify(ip, password) {
    const now = Date.now();
    const f = failures.get(ip) || { count: 0, lockedUntil: 0, lockMs: 60_000 };
    if (f.lockedUntil > now) return [429, `too many wrong passwords. try again in ${Math.ceil((f.lockedUntil - now) / 1000)} seconds`];
    const stored = getPassword();
    if (!stored) return [403, "the panel password isn't set yet. set it in Stagelight on the stream PC"];
    const ok = typeof password === 'string' && password.length <= 200 && checkPassword(password, stored);
    if (!ok) {
      f.count++;
      if (f.count >= 5) { f.lockedUntil = now + f.lockMs; f.lockMs = Math.min(f.lockMs * 2, 3600_000); f.count = 0; }
      failures.set(ip, f);
      log(`wrong panel password from ${ip}`);
      return [401, f.lockedUntil > now ? `too many wrong passwords. try again in ${Math.ceil((f.lockedUntil - now) / 1000)} seconds` : 'wrong password'];
    }
    failures.delete(ip);
    return null;
  }

  async function login(req, res) {
    const ip = ipOf(req), now = Date.now();
    let body;
    try { body = await readBody(req); } catch { return send(res, 400, { error: 'bad request' }); }
    const bad = verify(ip, body.password);
    if (bad) return send(res, bad[0], { error: bad[1] });
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { expires: now + SESSION_MS, ip });
    log(`panel opened from ${ip}`);
    send(res, 200, { ok: true }, undefined, { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
  }

  async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'bad request', 'text/plain'); }
    const p = url.pathname;

    if (req.method === 'GET' && FILES[p]) {
      const [file, type] = FILES[p];
      return fs.readFile(path.join(PANEL, file), (err, data) => (err ? send(res, 404, 'not found', 'text/plain') : send(res, 200, data, type)));
    }
    if (p === '/api/login' && req.method === 'POST') {
      if (!fromPanel(req)) return send(res, 403, { error: 'not from the panel' });
      return login(req, res);
    }
    if (!p.startsWith('/api/')) return send(res, 404, 'not found', 'text/plain');

    const session = sessionOf(req);
    if (!session) return send(res, 401, { error: 'log in first' });

    if (p === '/api/state' && req.method === 'GET') return send(res, 200, obs.snapshot());
    if (p === '/api/remote' && req.method === 'GET') {
      if (!remote) return send(res, 200, { view: false });
      return send(res, 200, { ...remote.info(), screens: remote.settings().view ? await remote.screens() : [] });
    }
    if (p === '/api/preview' && req.method === 'GET') {
      const jpg = await obs.screenshot();
      return jpg ? send(res, 200, jpg, 'image/jpeg') : send(res, 503, { error: 'no preview right now' });
    }
    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
      res.write(`retry: 2000\ndata: ${JSON.stringify(obs.snapshot())}\n\n`);
      const w = { res, token: session.token };
      watchers.add(w);
      req.on('close', () => watchers.delete(w));
      return;
    }
    if (req.method !== 'POST' || !fromPanel(req)) return send(res, 403, { error: 'not from the panel' });
    if (p === '/api/logout') {
      sessions.delete(session.token);
      for (const w of watchers) if (w.token === session.token) w.res.end();
      return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }
    // the remote display: the password again first (a phone left logged in isn't enough)
    if (p === '/api/remote/start' && remote) {
      let body;
      try { body = await readBody(req, 200_000); } catch { return send(res, 400, { error: 'bad request' }); }
      const bad = verify(ipOf(req), body.password);
      if (bad) return send(res, bad[0], { error: bad[1] });
      try {
        return send(res, 200, await remote.start({ sdp: body.sdp, screenId: String(body.screen || ''), quality: String(body.quality || ''), from: ipOf(req) }));
      } catch (err) {
        return send(res, 409, { error: err.message });
      }
    }
    if (p === '/api/remote/stop' && remote) { remote.end('ended from the panel'); return send(res, 200, { ok: true }); }
    if (p === '/api/action') {
      let body;
      try { body = await readBody(req); } catch { return send(res, 400, { error: 'bad request' }); }
      try {
        await obs.act(body);
        if (!['move', 'resize', 'volume'].includes(body.type)) log(`${body.type}${body.name ? ` "${body.name}"` : ''} from ${ipOf(req)}`);
        return send(res, 200, { ok: true });
      } catch (err) {
        return send(res, 409, { error: err.message || 'OBS said no' });
      }
    }
    return send(res, 404, { error: 'not found' });
  }

  // OBS changed: tell every open panel (and close the ones whose login ran out)
  function broadcast(snap) {
    const msg = `data: ${JSON.stringify(snap)}\n\n`;
    for (const w of watchers) {
      const s = sessions.get(w.token);
      if (!s || Date.now() > s.expires) { w.res.end(); watchers.delete(w); continue; }
      w.res.write(msg);
    }
  }
  setInterval(() => { for (const w of watchers) w.res.write(': ping\n\n'); }, 20_000).unref();

  return {
    start(wantPort = 4850) {
      return new Promise((resolve, reject) => {
        if (server) server.close();
        server = http.createServer((req, res) => handle(req, res).catch(() => send(res, 500, { error: 'something went wrong' })));
        server.once('error', reject);
        // every network on this PC: the home network and Tailscale
        server.listen(wantPort, '0.0.0.0', () => { port = wantPort; resolve(port); });
      });
    },
    stop() { if (server) server.close(); server = null; for (const w of watchers) w.res.end(); watchers.clear(); },
    port: () => port,
    broadcast,
    // a new password: everyone has to log in again
    logoutAll() { sessions.clear(); for (const w of watchers) w.res.end(); watchers.clear(); },
    sessionCount: () => [...sessions.values()].filter(s => Date.now() < s.expires).length,
  };
}

module.exports = { createServer, hashPassword, checkPassword };
