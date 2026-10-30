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
const files = require('./files');

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
/* Files uploaded from the panel for the layout: only pictures, videos and sounds, recognised by
   their first bytes (not by their name), up to 200 MB, saved in Stagelight's own media folder
   under a name Stagelight picks. */
const UPLOAD_MAX = 200 * 1024 * 1024;
function mediaType(head) {
  const s = (a, b) => head.subarray(a, b).toString('latin1');
  if (head[0] === 0x89 && s(1, 4) === 'PNG') return ['image', 'png'];
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return ['image', 'jpg'];
  if (s(0, 4) === 'GIF8') return ['image', 'gif'];
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return ['image', 'webp'];
  if (s(0, 2) === 'BM') return ['image', 'bmp'];
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return ['audio', 'wav'];
  if (s(0, 4) === 'OggS') return ['audio', 'ogg'];
  if (s(0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return ['audio', 'mp3'];
  if (s(0, 4) === 'fLaC') return ['audio', 'flac'];
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return ['video', 'webm'];
  if (s(4, 8) === 'ftyp') {
    const brand = s(8, 12);
    if (/^M4A/.test(brand)) return ['audio', 'm4a'];
    return ['video', /^qt/.test(brand) ? 'mov' : 'mp4'];
  }
  return null;
}

const loopback = a => /^(127\.|::1$|::ffff:127\.)/.test(String(a || ''));

function createServer({ obs, remote = null, mediaDir = '', filesOn = () => false, onFiles = () => {}, getAccounts, getWeb = () => ({ on: false, host: '' }), log = () => {}, onWatchers = () => {} }) {
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
    if (p === '/api/obs-settings' && req.method === 'GET') {
      if (!atLeast(session.role, 'full')) return send(res, 403, { error: "only full access accounts can see OBS's settings" });
      try { return send(res, 200, await obs.obsSettings()); } catch (err) { return send(res, 409, { error: err.message }); }
    }
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
    // the remote display through the web address: the pictures, as one long answer
    if (p === '/api/remote/relay' && req.method === 'GET' && remote) {
      if (!atLeast(session.role, 'full')) return send(res, 403, { error: 'your account has no access to the remote display' });
      if (!remote.relayAllowed(session.token)) return send(res, 409, { error: 'the remote display is not open' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
      res.flushHeaders();
      if (!remote.relayWatch(res, session.token)) { res.end(); }
      return;
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
    // file transfer (remote display): browsing and downloads are GETs, so they're handled here
    if (p.startsWith('/api/files/')) return filesApi(req, res, url, session);
    const isUpload = p === '/api/upload' && req.method === 'POST' && req.headers['x-stagelight'] === '1' && /^application\/octet-stream\b/.test(req.headers['content-type'] || '');
    if (!isUpload && (req.method !== 'POST' || !fromPanel(req))) return send(res, 403, { error: 'not from the panel' });
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
        return send(res, 200, await remote.start({ sdp: body.sdp, relay: body.relay === true, owner: session.token, screenId: String(body.screen || ''), quality: String(body.quality || ''), from: `${session.user} (${ipOf(req)})`, ice: getWeb().on ? STUN : [] }));
      } catch (err) {
        return send(res, 409, { error: err.message });
      }
    }
    // mouse and keyboard for the remote display through the web address, a few at a time
    if (p === '/api/remote/relay/input' && remote) {
      if (!atLeast(session.role, 'full')) return send(res, 403, { error: 'your account has no access to the remote display' });
      let body;
      try { body = await readBody(req, 50_000); } catch { return send(res, 400, { error: 'bad request' }); }
      const events = Array.isArray(body.events) ? body.events.slice(0, 300) : [];
      for (const ev of events) if (!remote.relayInput(session.token, ev)) return send(res, 409, { error: 'the remote display is not open' });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/remote/stop' && remote) {
      if (atLeast(session.role, 'full')) remote.end('ended from the panel');
      return send(res, 200, { ok: true });
    }
    // OBS's own settings: full access only, and every change is noted (never the stream key)
    if (p === '/api/obs-settings') {
      if (!atLeast(session.role, 'full')) return send(res, 403, { error: "only full access accounts can change OBS's settings" });
      let body;
      try { body = await readBody(req); } catch { return send(res, 400, { error: 'bad request' }); }
      try {
        const what = await obs.setObsSettings(body);
        log(`${session.user} changed OBS's ${what}`);
        return send(res, 200, { ok: true, what });
      } catch (err) {
        return send(res, 409, { error: err.message || 'OBS said no' });
      }
    }
    // a picture, video or sound from the panel, straight into a scene
    if (p === '/api/upload') {
      if (!atLeast(session.role, 'control')) return send(res, 403, { error: 'your account can watch, not change things' });
      if (!mediaDir) return send(res, 404, { error: 'not found' });
      return upload(req, res, url, session);
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

  function upload(req, res, url, session) {
    const size = Number(req.headers['content-length']);
    if (!Number.isFinite(size) || size <= 0) return send(res, 411, { error: 'the file is empty' });
    if (size > UPLOAD_MAX) { req.resume(); return send(res, 413, { error: 'that file is too big (200 MB at most)' }); }
    // a name for it: the time, and the letters of the original name that are safe in a file name
    const given = String(url.searchParams.get('file') || 'file').replace(/\.[^.]*$/, '').replace(/[^\w .-]+/g, '').replace(/^[.\s]+/, '').trim().slice(0, 40) || 'file';
    fs.mkdirSync(mediaDir, { recursive: true });
    const tmp = path.join(mediaDir, `.upload-${crypto.randomBytes(8).toString('hex')}`);
    const out = fs.createWriteStream(tmp, { flags: 'wx' });
    let got = 0, head = Buffer.alloc(0), kind = null, failed = null;
    const fail = (code, msg) => {
      if (failed) return;
      failed = [code, msg];
      req.unpipe(out); req.resume(); out.destroy();
      fs.rm(tmp, { force: true }, () => {});
      send(res, code, { error: msg });
    };
    req.on('data', chunk => {
      got += chunk.length;
      if (got > UPLOAD_MAX || got > size) return fail(413, 'that file is too big (200 MB at most)');
      if (!kind && head.length < 16) {
        head = Buffer.concat([head, chunk]).subarray(0, 16);
        if (head.length >= 12) { kind = mediaType(head); if (!kind) fail(415, 'only pictures (png, jpg, gif, webp), videos (mp4, mov, webm, mkv) and sounds (mp3, wav, ogg, m4a, flac)'); }
      }
    });
    req.on('aborted', () => fail(400, 'the upload stopped'));
    req.pipe(out);
    out.on('error', () => fail(500, "couldn't save the file on the stream PC"));
    out.on('finish', async () => {
      if (failed) return;
      if (!kind || got !== size) return fail(400, 'the upload stopped');
      const file = path.join(mediaDir, `${Date.now()}-${given}.${kind[1]}`);
      try { fs.renameSync(tmp, file); } catch { return fail(500, "couldn't save the file on the stream PC"); }
      try {
        const name = await obs.addMedia({ scene: url.searchParams.get('scene') || '', file, type: kind[0], name: url.searchParams.get('name') || '' });
        log(`${session.user}: uploaded ${kind[0]} "${name}" (${Math.round(got / 1024)} KB)`);
        send(res, 200, { ok: true, name, type: kind[0] });
      } catch (err) {
        send(res, 409, { error: err.message || 'OBS said no' });
      }
    });
  }

  /* ───────────── file transfer (like AnyDesk's), for the remote display ─────────────
     Full access only, only while "allow file transfer" is on in Stagelight, and only after the
     account's password is typed again (good for 30 minutes). Every transfer is noted. */
  const FILES_MS = 30 * 60_000;
  async function filesApi(req, res, url, session) {
    const p = url.pathname;
    const fail = (code, error, extra = {}) => send(res, code, { error, ...extra });
    if (!atLeast(session.role, 'full')) return fail(403, 'only full access accounts can use file transfer');
    if (!filesOn()) return fail(403, 'file transfer is switched off in Stagelight on the stream PC');
    const s = sessions.get(session.token);
    if (p === '/api/files/state' && req.method === 'GET') return send(res, 200, { on: true, unlocked: !!(s && s.filesUntil > Date.now()) });
    if (p === '/api/files/unlock' && req.method === 'POST') {
      if (!fromPanel(req)) return fail(403, 'not from the panel');
      let body; try { body = await readBody(req); } catch { return fail(400, 'bad request'); }
      const account = verify(ipOf(req), session.user, body.password, viaWeb(req));
      if (account.error) return fail(account.error[0], account.error[1]);
      if (s) s.filesUntil = Date.now() + FILES_MS;
      log(`${session.user} opened file transfer from ${ipOf(req)}`);
      return send(res, 200, { ok: true });
    }
    if (!s || !(s.filesUntil > Date.now())) return fail(423, 'type your password again to use file transfer', { locked: true });
    s.filesUntil = Date.now() + FILES_MS; // in use: stays open
    const who = `${session.user} (${ipOf(req)})`;
    try {
      if (p === '/api/files/list' && req.method === 'GET') return send(res, 200, await files.list(url.searchParams.get('path') || ''));
      if (p === '/api/files/download' && req.method === 'GET') {
        const target = url.searchParams.get('path') || '';
        const r = url.searchParams.get('zip') === '1' ? await files.sendZip(res, target) : await files.sendFile(res, target);
        log(`${who} downloaded ${r.files != null ? `the folder ${target} (${r.files} files, ` : `${target} (`}${Math.round(r.size / 1024)} KB)${r.stopped ? ', stopped' : ''}`);
        onFiles(`${session.user} downloaded ${r.name}`);
        return;
      }
      if (p === '/api/files/upload' && req.method === 'POST') {
        if (req.headers['x-stagelight'] !== '1' || !/^application\/octet-stream\b/.test(req.headers['content-type'] || '')) return fail(403, 'not from the panel');
        const r = await files.receive(req, url.searchParams.get('dir') || '', url.searchParams.get('rel') || '');
        log(`${who} uploaded ${r.path} (${Math.round(r.size / 1024)} KB)`);
        onFiles(`${session.user} uploaded ${r.name}`);
        return send(res, 200, { ok: true, name: r.name });
      }
      if (p === '/api/files/mkdir' && req.method === 'POST') {
        if (!fromPanel(req)) return fail(403, 'not from the panel');
        let body; try { body = await readBody(req); } catch { return fail(400, 'bad request'); }
        const r = await files.makeDir(body.dir, body.name);
        log(`${who} made the folder ${r.path}`);
        return send(res, 200, { ok: true, name: r.name });
      }
      return fail(404, 'not found');
    } catch (err) {
      if (res.headersSent) { res.destroy(); return; }
      const msg = err.code === 'ENOENT' ? "that isn't there any more" : err.code === 'EACCES' || err.code === 'EPERM' ? "Windows doesn't allow that here" : err.code === 'ENOTDIR' ? "that's not a folder" : err.message || 'something went wrong';
      return fail(typeof err.code === 'number' ? err.code : 409, msg);
    }
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

module.exports = { createServer, hashPassword, checkPassword, ROLES, mediaType };
