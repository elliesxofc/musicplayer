'use strict';

/* Stagelight's web server: the remote panel for any browser on the same network (or through
   Tailscale), behind a password.

   - everyone has their own username and password (stored only as scrypt hashes) and an access
     level: "full" (everything, and the remote display of the whole PC), "control" (the stream:
     going live, scenes, sources, audio, layout) or "watch" (see it all, change nothing)
   - logging in gives a session cookie
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

const ROLES = ['watch', 'control', 'full'];
const atLeast = (role, need) => ROLES.indexOf(role) >= ROLES.indexOf(need);
const DUMMY = hashPassword('not-an-account'); // so a wrong username takes as long as a wrong password

/* Through a web address (Cloudflare Tunnel): the cloudflared program on this PC passes visits on
   to Stagelight, so they arrive from this PC itself, with Cloudflare's headers saying who the
   visitor really is. Only accepted when "allow access through a web address" is on. */
const STUN = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];
const loopback = a => /^(127\.|::1$|::ffff:127\.)/.test(String(a || ''));

function createServer({ obs, remote = null, getAccounts, getWeb = () => ({ on: false, host: '' }), log = () => {}, onWatchers = () => {} }) {
  const sessions = new Map(); // token → { expires, ip }
  const failures = new Map(); // ip → { count, lockedUntil, lockMs }
  const watchers = new Set(); // open event streams: { res, token }
  let server = null, port = 0;

  // a visit through Cloudflare: from this PC, with Cloudflare's headers
  const viaWeb = req => loopback(req.socket.remoteAddress) && !!(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
  // who's asking: the visitor's own address (Cloudflare's header for web visits), so one person's
  // wrong passwords lock out that person, not everyone coming through Cloudflare
  const ipOf = req => {
    if (viaWeb(req)) { const ip = String(req.headers['cf-connecting-ip'] || '').trim(); if (/^[0-9a-f.:]{3,45}$/i.test(ip)) return ip; }
    return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  };
  let lastWebVisit = 0;
  // wrong passwords from the internet as a whole: lots of them (many addresses guessing) pause
  // web logins for a while; the home network and Tailscale aren't affected
  let webFails = [], webPausedUntil = 0;
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

  const findAccount = name => (getAccounts() || []).find(a => a.name.toLowerCase() === String(name || '').trim().toLowerCase()) || null;

  function sessionOf(req) {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,100})`).exec(req.headers.cookie || '');
    if (!m) return null;
    const s = sessions.get(m[1]);
    if (!s) return null;
    if (Date.now() > s.expires) { sessions.delete(m[1]); return null; }
    // the account may have been removed (or its access changed) since logging in
    const account = findAccount(s.user);
    if (!account || account.stamp !== s.stamp) { sessions.delete(m[1]); return null; }
    return { token: m[1], ...s, role: account.role };
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

  // username + password, with the lockout: the account when they're right, otherwise { error: [status, message] }
  function verify(ip, username, password, web = false) {
    const now = Date.now();
    if (web && webPausedUntil > now) return { error: [429, `too many wrong tries from the internet. logging in through the web address is paused for ${Math.ceil((webPausedUntil - now) / 60_000)} minutes`] };
    const f = failures.get(ip) || { count: 0, lockedUntil: 0, lockMs: 60_000 };
    if (f.lockedUntil > now) return { error: [429, `too many wrong tries. try again in ${Math.ceil((f.lockedUntil - now) / 1000)} seconds`] };
    if (!(getAccounts() || []).length) return { error: [403, 'no accounts yet. add one in Stagelight on the stream PC'] };
    const account = typeof username === 'string' && username.length <= 64 ? findAccount(username) : null;
    const pw = typeof password === 'string' && password.length <= 200 ? password : '';
    const ok = checkPassword(pw, account || DUMMY) && !!account;
    if (!ok) {
      f.count++;
      if (f.count >= 5) { f.lockedUntil = now + f.lockMs; f.lockMs = Math.min(f.lockMs * 2, 3600_000); f.count = 0; }
      failures.set(ip, f);
      log(`wrong username or password from ${ip}${web ? ' (web address)' : ''}`);
      if (web) {
        webFails = webFails.filter(t => now - t < 600_000);
        webFails.push(now);
        if (webFails.length >= 30) { webPausedUntil = now + 15 * 60_000; webFails = []; log('30 wrong tries from the internet in 10 minutes: web address logins paused for 15 minutes'); }
      }
      return { error: [401, f.lockedUntil > now ? `too many wrong tries. try again in ${Math.ceil((f.lockedUntil - now) / 1000)} seconds` : 'wrong username or password'] };
    }
    failures.delete(ip);
    return account;
  }

  async function login(req, res) {
    const ip = ipOf(req), now = Date.now();
    let body;
    try { body = await readBody(req); } catch { return send(res, 400, { error: 'bad request' }); }
    const web = viaWeb(req);
    const account = verify(ip, body.username, body.password, web);
    if (account.error) return send(res, account.error[0], { error: account.error[1] });
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { expires: now + SESSION_MS, ip, user: account.name, stamp: account.stamp });
    log(`${account.name} opened the panel from ${ip}${web ? ' (web address)' : ''}`);
    // through the web address it's HTTPS: the cookie is only ever sent over HTTPS
    send(res, 200, { ok: true }, undefined, { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${web ? '; Secure' : ''}` });
  }

  async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'bad request', 'text/plain'); }
    const p = url.pathname;

    // web visits: only when switched on, and only for the address set in Stagelight
    if (viaWeb(req)) {
      const web = getWeb();
      if (!web.on) return send(res, 403, 'the web address is switched off in Stagelight on the stream PC', 'text/plain; charset=utf-8');
      const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
      if (web.host && host !== web.host) return send(res, 403, 'this address is not the one set in Stagelight', 'text/plain; charset=utf-8');
      lastWebVisit = Date.now();
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    }

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

    if (p === '/api/me' && req.method === 'GET') return send(res, 200, { user: session.user, role: session.role });
    if (p === '/api/state' && req.method === 'GET') return send(res, 200, obs.snapshot());
    if (p === '/api/browser' && req.method === 'GET') {
      if (!atLeast(session.role, 'control')) return send(res, 403, { error: 'your account can watch, not change things' });
      try { return send(res, 200, await obs.browserSettings(url.searchParams.get('scene') || '', url.searchParams.get('id'))); } catch (err) { return send(res, 409, { error: err.message }); }
    }
    if (p === '/api/remote' && req.method === 'GET') {
      if (!remote || !atLeast(session.role, 'full')) return send(res, 200, { view: false, allowed: false });
      // with the web address on, the video also tries a direct way over the internet (STUN)
      return send(res, 200, { ...remote.info(), screens: remote.settings().view ? await remote.screens() : [], ice: getWeb().on ? STUN : [] });
    }
    if (p === '/api/preview' && req.method === 'GET') {
      const scene = url.searchParams.get('scene') || undefined;
      const jpg = await obs.screenshot(scene);
      if (!jpg) return send(res, 503, { error: 'no preview right now' });
      // the panel already has this picture: say so instead of sending it again
      const tag = obs.shotTag(scene);
      if (req.headers['if-none-match'] === tag) { res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-cache' }); return res.end(); }
      return send(res, 200, jpg, 'image/jpeg', { ETag: tag, 'Cache-Control': 'no-cache' });
    }
    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
      res.write(`retry: 2000\ndata: ${JSON.stringify(obs.snapshot())}\n\n`);
      const w = { res, token: session.token };
      watchers.add(w);
      onWatchers(watchers.size);
      req.on('close', () => { watchers.delete(w); onWatchers(watchers.size); });
      return;
    }
    if (req.method !== 'POST' || !fromPanel(req)) return send(res, 403, { error: 'not from the panel' });
    if (p === '/api/logout') {
      sessions.delete(session.token);
      for (const w of watchers) if (w.token === session.token) w.res.end();
      return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${viaWeb(req) ? '; Secure' : ''}` });
    }
    // the remote display: the password again first (a phone left logged in isn't enough)
    if (p === '/api/remote/start' && remote) {
      if (!atLeast(session.role, 'full')) return send(res, 403, { error: 'your account has no access to the remote display' });
      let body;
      try { body = await readBody(req, 200_000); } catch { return send(res, 400, { error: 'bad request' }); }
      // the same account's password again
      const account = verify(ipOf(req), session.user, body.password, viaWeb(req));
      if (account.error) return send(res, account.error[0], { error: account.error[1] });
      try {
        return send(res, 200, await remote.start({ sdp: body.sdp, screenId: String(body.screen || ''), quality: String(body.quality || ''), from: `${session.user} (${ipOf(req)})`, ice: getWeb().on ? STUN : [] }));
      } catch (err) {
        return send(res, 409, { error: err.message });
      }
    }
    if (p === '/api/remote/stop' && remote) {
      if (atLeast(session.role, 'full')) remote.end('ended from the panel');
      return send(res, 200, { ok: true });
    }
    if (p === '/api/action') {
      if (!atLeast(session.role, 'control')) return send(res, 403, { error: 'your account can watch, not change things' });
      let body;
      try { body = await readBody(req); } catch { return send(res, 400, { error: 'bad request' }); }
      try {
        await obs.act(body);
        if (!['move', 'resize', 'volume'].includes(body.type)) log(`${session.user}: ${body.type}${body.name ? ` "${String(body.name).slice(0, 80)}"` : ''}`);
        return send(res, 200, { ok: true });
      } catch (err) {
        return send(res, 409, { error: err.message || 'OBS said no' });
      }
    }
    return send(res, 404, { error: 'not found' });
  }

  // OBS changed: tell every open panel (and close the ones whose login ran out)
  function broadcast() {
    if (!watchers.size) return; // nobody looking: nothing to build or send
    const msg = `data: ${JSON.stringify(obs.snapshot())}\n\n`;
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
    // one account removed or changed: only its logins end
    logoutUser(name) {
      const n = String(name).toLowerCase();
      for (const [t, s] of sessions) if (s.user.toLowerCase() === n) sessions.delete(t);
      for (const w of watchers) if (!sessions.has(w.token)) { w.res.end(); watchers.delete(w); }
    },
    sessionCount: () => [...sessions.values()].filter(s => Date.now() < s.expires).length,
    watcherCount: () => watchers.size,
    lastWebVisit: () => lastWebVisit,
  };
}

module.exports = { createServer, hashPassword, checkPassword, ROLES };
