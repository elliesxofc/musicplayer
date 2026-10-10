'use strict';

/* "Now playing" overlay for OBS (desktop app only).
   A tiny web server on this PC only (127.0.0.1, never reachable from the internet):
     /overlay  the page to add in OBS as a Browser Source
     /events   live updates for that page (server-sent events)
     /now      the current song as JSON
     /cover    the current song's cover art */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORTS = [4848, 4849, 4850, 4851, 4852];
const EMPTY = { id: null, title: '', artist: '', album: '', line: '', duration: 0, position: 0, playing: false, spectrum: true, next: null };

function createOverlay() {
  let state = { ...EMPTY };
  let updatedAt = Date.now();
  const covers = new Map(); // song id → { type, bytes }: the last few, from moonlit and Spotify
  const clients = new Set();
  let port = null;
  let watchersChanged = () => {};
  const watchers = () => watchersChanged(clients.size);

  const page = () => fs.readFileSync(path.join(__dirname, 'overlay.html'));
  // position is sent as "seconds at the moment of sending"; the page keeps time from there
  const snapshot = () => JSON.stringify({ ...state, sentAt: Date.now() });

  function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    if (req.method !== 'GET') { res.writeHead(405, cors); return res.end(); }
    if (url.pathname === '/' || url.pathname === '/overlay') {
      res.writeHead(200, { ...cors, 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page());
    }
    if (url.pathname === '/now') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(snapshot());
    }
    if (url.pathname === '/cover') {
      // the current song's cover, or the next song's (for "up next") when asked by id
      const want = url.searchParams.get('id');
      const cover = covers.get(want || state.id);
      if (!cover) { res.writeHead(404, cors); return res.end(); }
      res.writeHead(200, { ...cors, 'Content-Type': cover.type || 'image/jpeg' });
      return res.end(cover.bytes);
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
      res.write(`retry: 2000\ndata: ${snapshot()}\n\n`);
      clients.add(res);
      watchers();
      req.on('close', () => { clients.delete(res); watchers(); });
      return;
    }
    res.writeHead(404, cors);
    res.end();
  }

  const server = http.createServer(handle);
  // keep connections alive through proxies/idle timers
  setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20000).unref();

  function listen(i = 0) {
    return new Promise(resolve => {
      if (i >= PORTS.length) return resolve(null);
      server.once('error', () => resolve(listen(i + 1)));
      server.listen(PORTS[i], '127.0.0.1', () => { port = PORTS[i]; resolve(port); });
    });
  }

  return {
    start: () => listen(),
    url: () => (port ? `http://localhost:${port}/overlay` : null),
    update(next) {
      state = { ...EMPTY, ...next };
      updatedAt = Date.now();
      const msg = `data: ${snapshot()}\n\n`;
      for (const c of clients) c.write(msg);
    },
    setCover(id, type, bytes) {
      covers.delete(id);
      if (bytes) covers.set(id, { type, bytes: Buffer.from(bytes) });
      while (covers.size > 6) covers.delete(covers.keys().next().value);
      // the cover can arrive just after the song itself: tell the overlay to fetch it now
      if (bytes && id === state.id) {
        const msg = `event: cover\ndata: ${JSON.stringify(id)}\n\n`;
        for (const c of clients) c.write(msg);
      }
    },
    // music bar levels (0-255), sent as their own small event about 30 times a second
    spectrum(levels) {
      if (!clients.size || !Array.isArray(levels)) return;
      const msg = `event: spectrum\ndata: ${levels.slice(0, 64).map(v => Math.max(0, Math.min(255, v | 0))).join(',')}\n\n`;
      for (const c of clients) c.write(msg);
    },
    onWatchers(cb) { watchersChanged = cb; },
    // what's on the overlay right now, with the song's clock moved on to this moment
    now() {
      const position = state.position + (state.playing ? (Date.now() - updatedAt) / 1000 : 0);
      return { ...state, position: state.duration ? Math.min(state.duration, position) : position };
    },
    stop: () => { for (const c of clients) c.end(); server.close(); },
  };
}

module.exports = { createOverlay };
