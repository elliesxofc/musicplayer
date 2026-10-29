'use strict';

/* The remote display (the whole PC, like AnyDesk or Parsec), from the panel.

   Off unless switched on in Stagelight on the stream PC; mouse and keyboard is a second
   switch. While someone is connected, a small bar shows at the top of the screen (with a
   button to stop it), and Windows shows a notification. One person at a time. */

const { BrowserWindow, desktopCapturer, screen, Notification, ipcMain, session } = require('electron');
const path = require('node:path');
const { createInput } = require('./input-win');

const QUALITY = {
  light: { width: 854, height: 480, fps: 15, bitrate: 800_000 }, // for a weak connection
  smooth: { width: 1280, height: 720, fps: 30, bitrate: 3_000_000 },
  sharp: { width: 1920, height: 1080, fps: 30, bitrate: 8_000_000 },
  fast: { width: 1280, height: 720, fps: 60, bitrate: 6_000_000 },
};

/* While OBS is live, the picture shares the stream PC's upload with the stream, and the stream
   comes first: the picture is kept small, and smaller still as soon as OBS has trouble sending
   (dropped frames, congestion, reconnecting), until the stream has been fine for a minute. */
const LIVE = { bitrate: 1_200_000, fps: 15 };
const STRUGGLING = { bitrate: 400_000, fps: 8 };
const CALM_MS = 60_000;

// the most upload the stream PC lets the picture use (set in Stagelight, 0 = no limit), on top
function limitFor(q, stream, guard, now = Date.now(), max = 0) {
  const l = liveLimit(q, stream, guard, now);
  if (max > 0 && max < l.bitrate) { l.bitrate = max; l.saving = true; if (l.level === 'full') l.level = 'capped'; }
  return l;
}
function liveLimit(q, stream, guard, now) {
  if (!stream || !stream.active) { guard.until = 0; return { bitrate: q.bitrate, fps: q.fps, saving: false, level: 'full' }; }
  const dropped = guard.skipped != null && stream.skipped > guard.skipped && (stream.skipped - guard.skipped) >= Math.max(3, (stream.total - guard.total) * 0.005);
  guard.skipped = stream.skipped; guard.total = stream.total;
  if (stream.reconnecting || stream.congestion > 0.2 || dropped) guard.until = now + CALM_MS;
  const l = guard.until > now ? STRUGGLING : LIVE;
  return { bitrate: Math.min(q.bitrate, l.bitrate), fps: Math.min(q.fps, l.fps), saving: true, level: l === STRUGGLING ? 'low' : 'live' };
}
const mbps = b => `${Math.round(b / 100_000) / 10} Mbps`;
const NOTES = {
  full: (l, was) => (was === 'capped' ? 'no upload limit any more: full picture again' : 'the stream ended: full picture again'),
  capped: l => `the stream PC lets the picture use up to ${mbps(l.bitrate)} of its upload`,
  live: "you're live: the picture is kept light so the stream keeps its upload",
  low: 'the stream is struggling: the picture is lowered to give it room',
};

const note = (l, was) => (typeof NOTES[l.level] === 'function' ? NOTES[l.level](l, was) : NOTES[l.level]);

function createRemote({ root, icon, getSettings, log = () => {}, onChange = () => {} }) {
  let capture = null, bar = null, active = null, nextJob = 1, closeTimer = null, stream = null;
  const waiting = new Map(); // job id → resolve
  const input = createInput({ log });

  /* ───────────── the screens on this PC ───────────── */
  async function screens() {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).catch(() => []);
    const displays = screen.getAllDisplays();
    return sources.map((s, i) => {
      const d = displays.find(x => String(x.id) === String(s.display_id)) || displays[i] || screen.getPrimaryDisplay();
      const primary = d.id === screen.getPrimaryDisplay().id;
      return {
        id: s.id, displayId: d.id,
        name: `${primary ? 'main screen' : `screen ${i + 1}`} · ${Math.round(d.bounds.width * d.scaleFactor)} × ${Math.round(d.bounds.height * d.scaleFactor)}`,
        primary,
      };
    }).sort((a, b) => b.primary - a.primary);
  }

  function captureWindow() {
    if (capture && !capture.isDestroyed()) return capture;
    capture = new BrowserWindow({
      show: false, width: 320, height: 200, skipTaskbar: true,
      webPreferences: { preload: path.join(root, 'capture-preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    capture.loadFile(path.join(root, 'capture.html'));
    capture.on('closed', () => { capture = null; });
    return capture;
  }

  // the bar at the top of the screen while someone is connected
  function showBar(text) {
    if (!bar || bar.isDestroyed()) {
      const d = screen.getPrimaryDisplay().workArea;
      bar = new BrowserWindow({
        width: 460, height: 44, x: Math.round(d.x + d.width / 2 - 230), y: d.y + 6,
        frame: false, transparent: true, resizable: false, movable: true, alwaysOnTop: true, skipTaskbar: true, focusable: false,
        webPreferences: { preload: path.join(root, 'bar-preload.js'), contextIsolation: true, sandbox: true },
      });
      bar.setAlwaysOnTop(true, 'screen-saver');
      bar.loadFile(path.join(root, 'bar.html'), { query: { text } });
      bar.on('closed', () => { bar = null; });
    } else {
      bar.webContents.send('text', text);
    }
  }
  const hideBar = () => { if (bar && !bar.isDestroyed()) bar.close(); bar = null; };

  ipcMain.on('answer', (_e, id, result) => { const done = waiting.get(id); if (done) { waiting.delete(id); done(result); } });
  ipcMain.on('ended', (_e, why) => { if (active) end(why || 'the connection ended'); });
  ipcMain.on('bar-stop', () => end('stopped on the stream PC'));
  ipcMain.on('input', (e, msg) => {
    if (!capture || e.sender !== capture.webContents) return;
    handleInput(msg);
  });

  /* ───────────── start / end ───────────── */
  async function start({ sdp, screenId, quality, from, ice = [] }) {
    const s = getSettings();
    if (!s.view) throw new Error('the remote display is switched off in Stagelight on the stream PC');
    if (typeof sdp !== 'string' || sdp.length > 100_000 || !/^v=0/.test(sdp)) throw new Error('bad request');
    const list = await screens();
    const scr = list.find(x => x.id === screenId) || list[0];
    if (!scr) throw new Error("couldn't find a screen to share");
    if (active) end('someone else connected');
    clearTimeout(closeTimer);
    const q = QUALITY[quality] || QUALITY.smooth;
    const guard = {};
    const limit = limitFor(q, stream, guard, Date.now(), s.max);
    if (limit.level !== 'full') limit.note = note(limit);
    const id = nextJob++;
    const win = captureWindow();
    if (win.webContents.isLoading()) await new Promise(r => win.webContents.once('did-finish-load', r));
    const result = await new Promise(resolve => {
      waiting.set(id, resolve);
      win.webContents.send('start', { id, sourceId: scr.id, offer: sdp, ice, ...q, limit });
      setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); resolve({ error: 'the screen took too long to start' }); } }, 15_000);
    });
    if (result.error) throw new Error(result.error);
    active = { from, displayId: scr.displayId, control: !!s.control, since: Date.now(), q, guard, level: limit.level, bitrate: limit.bitrate };
    const what = active.control ? 'controlling' : 'watching';
    log(`remote display: ${from} is ${what} this PC`);
    showBar(`${from} is ${what} this PC`);
    if (Notification.isSupported()) new Notification({ title: 'Stagelight: remote display on', body: `${from} is ${what} this PC through the panel.`, icon }).show();
    onChange();
    return { sdp: result.sdp, control: active.control };
  }

  function end(why = '') {
    if (!active) return;
    input.releaseAll();
    if (capture && !capture.isDestroyed()) capture.webContents.send('stop', why);
    log(`remote display ended${why ? ` (${why})` : ''}`);
    active = null;
    hideBar();
    onChange();
    // the hidden screen-sharing window goes too (a minute later, in case of a reconnect)
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (!active && capture && !capture.isDestroyed()) capture.destroy(); }, 60_000);
  }

  /* ───────────── mouse and keyboard from the panel ───────────── */
  let lastMove = 0;
  function handleInput(m) {
    if (!active || !m || typeof m !== 'object') return;
    if (!active.control || !getSettings().control || !input.available()) return; // watching only
    const d = screen.getAllDisplays().find(x => x.id === active.displayId) || screen.getPrimaryDisplay();
    // the panel sends places as 0…1 across the shared screen; Windows wants real pixels
    const rect = process.platform === 'win32' ? screen.dipToScreenRect(null, d.bounds) : d.bounds;
    const at = (x, y) => {
      const fx = Math.max(0, Math.min(1, Number(x))), fy = Math.max(0, Math.min(1, Number(y)));
      if (!Number.isFinite(fx) || !Number.isFinite(fy)) return false;
      input.move(rect.x + fx * (rect.width - 1), rect.y + fy * (rect.height - 1));
      return true;
    };
    switch (m.t) {
      case 'm': if (Date.now() - lastMove > 8 || m.f) { lastMove = Date.now(); at(m.x, m.y); } break;
      case 'b': if (m.x != null) at(m.x, m.y); input.button(Number(m.b), !!m.d); break;
      case 'w': input.wheel(Number(m.dy) || 0, Number(m.dx) || 0); break;
      case 'k': if (typeof m.code === 'string') input.key(m.code, !!m.d); break;
      case 'txt': input.text(m.s); break;
      default: break;
    }
  }

  // OBS's stream changed (or was checked): adjust the picture's share of the upload
  function streamChanged(next) {
    stream = next;
    if (!active || !capture || capture.isDestroyed()) return;
    const limit = limitFor(active.q, stream, active.guard, Date.now(), getSettings().max);
    if (limit.level === active.level && limit.bitrate === active.bitrate) return;
    if (limit.level === 'low' && active.level !== 'low') log('remote display: the stream is struggling, the picture is lowered');
    const was = active.level;
    active.level = limit.level; active.bitrate = limit.bitrate;
    capture.webContents.send('limit', { ...limit, note: note(limit, was) });
  }

  return {
    start, end, streamChanged,
    screens,
    status: () => ({ active: !!active, from: active ? active.from : '', control: !!(active && active.control) }),
    canControl: () => input.available(),
    // the settings changed: switched off means the session ends now
    settingsChanged() {
      const s = getSettings();
      if (active && !s.view) end('switched off on the stream PC');
      else if (active && active.control && !s.control) { input.releaseAll(); active.control = false; showBar(`${active.from} is watching this PC`); onChange(); }
      if (active) streamChanged(stream); // the upload limit may have changed
    },
    stop() { end('Stagelight closed'); input.stop(); hideBar(); if (capture && !capture.isDestroyed()) capture.destroy(); },
  };
}

module.exports = { createRemote, QUALITY, limitFor };
