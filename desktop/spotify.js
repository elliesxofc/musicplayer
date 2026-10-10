'use strict';

/* Spotify's "now playing" in moonlit (desktop app only).
   You connect your own Spotify account once (through your own free Spotify developer app,
   so nothing goes through anyone else's server). moonlit then asks Spotify every few seconds
   what's playing, shows it with play/pause/skip buttons, and the overlay, nowplaying.txt and
   !song show the Spotify song while it plays. The buttons need Spotify Premium (Spotify's rule). */

const http = require('node:http');
const crypto = require('node:crypto');

const ACCOUNTS = process.env.MOONLIT_SPOTIFY_ACCOUNTS || 'https://accounts.spotify.com';
const API = process.env.MOONLIT_SPOTIFY_API || 'https://api.spotify.com';
// Spotify only accepts this exact address, typed into the developer app's settings
const REDIRECT_PORT = 4860;
const REDIRECT = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SCOPES = 'user-read-playback-state user-read-currently-playing user-modify-playback-state';
const POLL = 3000, POLL_IDLE = 10_000;

const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function createSpotify({ load, save, openBrowser, onState, onStatus, onCover }) {
  let auth = load(); // { clientId, refresh, access, expires }
  let timer = null, polling = false, last = null, lastCoverFor = null, loginServer = null;
  let status = auth.refresh ? { text: 'connecting…', kind: 'wait' } : { text: 'not connected', kind: 'off' };
  const setStatus = (text, kind) => { status = { text, kind }; onStatus(status); };

  async function token(force = false) {
    if (!auth.refresh) throw Object.assign(new Error('not connected'), { code: 'auth' });
    if (!force && auth.access && Date.now() < auth.expires - 60_000) return auth.access;
    const res = await fetch(`${ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: auth.refresh, client_id: auth.clientId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // the connection was removed on Spotify's side (or the developer app was deleted)
      if (data.error === 'invalid_grant' || data.error === 'invalid_client') {
        auth = { clientId: auth.clientId };
        save(auth);
        throw Object.assign(new Error('Spotify ended the connection, connect again'), { code: 'auth' });
      }
      throw new Error(data.error_description || `Spotify said ${res.status}`);
    }
    auth = { ...auth, access: data.access_token, expires: Date.now() + data.expires_in * 1000, refresh: data.refresh_token || auth.refresh };
    save(auth);
    return auth.access;
  }

  async function api(method, path, retried = false) {
    const res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${await token()}` } });
    if (res.status === 401 && !retried) { await token(true); return api(method, path, true); }
    return res;
  }

  function toState(p) {
    const item = p && p.item;
    if (!item) return null;
    const images = (item.album && item.album.images) || item.images || (item.show && item.show.images) || [];
    const cover = images.find(i => i.width && i.width <= 640) || images[0];
    return {
      id: `sp:${item.id || item.uri}`,
      title: item.name || '',
      artist: (item.artists || []).map(a => a.name).join(', ') || (item.show && item.show.name) || '',
      album: (item.album && item.album.name) || '',
      duration: (item.duration_ms || 0) / 1000,
      position: (p.progress_ms || 0) / 1000,
      playing: !!p.is_playing,
      cover: cover ? cover.url : '',
      url: (item.external_urls && item.external_urls.spotify) || '',
      device: (p.device && p.device.name) || '',
      at: Date.now(),
    };
  }

  async function poll() {
    if (polling) return;
    polling = true;
    let next = POLL;
    try {
      const res = await api('GET', '/v1/me/player?additional_types=episode');
      if (res.status === 429) {
        next = Math.max(POLL, Number(res.headers.get('retry-after') || 30) * 1000);
      } else if (res.status === 204) {
        publish(null);
        next = POLL_IDLE;
      } else if (res.ok) {
        const state = toState(await res.json());
        publish(state);
        if (!state || !state.playing) next = POLL_IDLE / 2;
      } else if (res.status === 403) {
        setStatus("Spotify didn't allow it. In your Spotify developer app, add your account under User Management", 'warn');
        next = POLL_IDLE * 3;
      } else {
        next = POLL_IDLE;
      }
      if (res.ok || res.status === 204) setStatus(last ? `connected · ${last.device || 'Spotify'}` : 'connected · nothing playing on Spotify', 'on');
    } catch (err) {
      if (err.code === 'auth') { setStatus(err.message === 'not connected' ? 'not connected' : err.message, 'warn'); publish(null); polling = false; return; }
      setStatus(`can't reach Spotify (${err.message}), trying again`, 'warn');
      next = POLL_IDLE * 2;
    }
    polling = false;
    schedule(next);
  }

  function schedule(ms) { clearTimeout(timer); timer = setTimeout(poll, ms); }

  function publish(state) {
    last = state;
    onState(state);
    if (state && state.cover && lastCoverFor !== state.id) {
      lastCoverFor = state.id;
      fetch(state.cover).then(r => (r.ok ? r.arrayBuffer() : null)).then(bytes => {
        if (bytes) onCover(state.id, 'image/jpeg', Buffer.from(bytes));
      }).catch(() => {});
    }
  }

  // Sign in through the browser (PKCE: no secret needed). Spotify sends you back to
  // http://127.0.0.1:4860/callback, which this little server answers.
  function connect(clientId) {
    clientId = String(clientId || '').trim();
    if (!/^[0-9a-f]{32}$/i.test(clientId)) return Promise.reject(new Error("that doesn't look like a Client ID (32 letters and numbers)"));
    if (loginServer) loginServer.close();
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const stateKey = b64url(crypto.randomBytes(16));
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (err, html) => {
        if (done) return;
        done = true;
        clearTimeout(giveUp);
        setTimeout(() => loginServer && loginServer.close(), 500);
        if (err) { setStatus(err.message, 'warn'); reject(err); } else resolve(html);
      };
      const page = (title, text) => `<!doctype html><meta charset="utf-8"><title>moonlit</title><body style="font:16px system-ui;background:#170a14;color:#fff3f8;display:grid;place-items:center;height:90vh;text-align:center"><div><h1 style="font-weight:600;color:#ff7eb6">${title}</h1><p>${text}</p></div>`;
      loginServer = http.createServer(async (req, res) => {
        const url = new URL(req.url, REDIRECT);
        if (url.pathname !== '/callback') { res.writeHead(404); return res.end(); }
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        if (url.searchParams.get('state') !== stateKey || (!code && !error)) { res.writeHead(400); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (error) {
          res.end(page('not connected', 'you can close this tab and try again in moonlit.'));
          return finish(new Error(error === 'access_denied' ? 'you cancelled the Spotify sign-in' : `Spotify said: ${error}`));
        }
        try {
          const r = await fetch(`${ACCOUNTS}/api/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }),
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data.error_description || data.error || `Spotify said ${r.status}`);
          auth = { clientId, refresh: data.refresh_token, access: data.access_token, expires: Date.now() + data.expires_in * 1000 };
          save(auth);
          res.end(page('connected ♡', 'Spotify is connected to moonlit. you can close this tab.'));
          setStatus('connected', 'on');
          finish(null);
          poll();
        } catch (err) {
          res.end(page('not connected', 'something went wrong. you can close this tab; moonlit says what happened.'));
          finish(err);
        }
      });
      loginServer.once('error', err => finish(new Error(err.code === 'EADDRINUSE'
        ? `port ${REDIRECT_PORT} is busy. close whatever uses it, then try again` : err.message)));
      loginServer.listen(REDIRECT_PORT, '127.0.0.1', () => {
        setStatus('waiting for you to sign in to Spotify in your browser…', 'wait');
        const q = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: REDIRECT, scope: SCOPES, code_challenge_method: 'S256', code_challenge: challenge, state: stateKey });
        openBrowser(`${ACCOUNTS}/authorize?${q}`);
      });
      const giveUp = setTimeout(() => finish(new Error('the Spotify sign-in timed out, try again')), 5 * 60_000);
    });
  }

  // play / pause / next / previous. Spotify only allows these with Premium.
  async function control(action) {
    const routes = { play: ['PUT', '/v1/me/player/play'], pause: ['PUT', '/v1/me/player/pause'], next: ['POST', '/v1/me/player/next'], previous: ['POST', '/v1/me/player/previous'] };
    const route = routes[action];
    if (!route) return { ok: false, message: 'unknown button' };
    try {
      const res = await api(route[0], route[1]);
      setTimeout(poll, 400); // show the change straight away
      if (res.ok) return { ok: true };
      const data = await res.json().catch(() => ({}));
      const reason = data.error && data.error.reason;
      if (reason === 'PREMIUM_REQUIRED') return { ok: false, message: 'the Spotify buttons need Spotify Premium' };
      if (reason === 'NO_ACTIVE_DEVICE' || res.status === 404) return { ok: false, message: 'open Spotify and play something first' };
      return { ok: false, message: (data.error && data.error.message) || `Spotify said ${res.status}` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  function disconnect() {
    clearTimeout(timer);
    auth = { clientId: auth.clientId };
    save(auth);
    publish(null);
    setStatus('not connected', 'off');
  }

  if (auth.refresh) setTimeout(poll, 500);

  return {
    connect, control, disconnect,
    info: () => ({ clientId: auth.clientId || '', connected: !!auth.refresh, status, state: last, redirect: REDIRECT }),
    stop: () => { clearTimeout(timer); if (loginServer) loginServer.close(); },
  };
}

module.exports = { createSpotify, REDIRECT };
