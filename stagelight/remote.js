'use strict';

/* The remote display (the whole PC, like AnyDesk or Parsec), from the panel.

   Off unless switched on in Stagelight on the stream PC; mouse and keyboard is a second
   switch. While someone is connected, a small bar shows at the top of the screen (with a
   button to stop it), and Windows shows a notification. One person at a time. */

const { BrowserWindow, desktopCapturer, screen, Notification, ipcMain, session } = require('electron');
const path = require('node:path');
const { createInput } = require('./input-win');

const QUALITY = {
  smooth: { width: 1280, height: 720, fps: 30, bitrate: 3_000_000 },
  sharp: { width: 1920, height: 1080, fps: 30, bitrate: 8_000_000 },
  fast: { width: 1280, height: 720, fps: 60, bitrate: 6_000_000 },
};

function createRemote({ root, icon, getSettings, log = () => {}, onChange = () => {} }) {
  let capture = null, bar = null, active = null, nextJob = 1;
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
  async function start({ sdp, screenId, quality, from }) {
    const s = getSettings();
    if (!s.view) throw new Error('the remote display is switched off in Stagelight on the stream PC');
    if (typeof sdp !== 'string' || sdp.length > 100_000 || !/^v=0/.test(sdp)) throw new Error('bad request');
    const list = await screens();
    const scr = list.find(x => x.id === screenId) || list[0];
    if (!scr) throw new Error("couldn't find a screen to share");
    if (active) end('someone else connected');
    const q = QUALITY[quality] || QUALITY.smooth;
    const id = nextJob++;
    const win = captureWindow();
    if (win.webContents.isLoading()) await new Promise(r => win.webContents.once('did-finish-load', r));
    const result = await new Promise(resolve => {
      waiting.set(id, resolve);
      win.webContents.send('start', { id, sourceId: scr.id, offer: sdp, ...q });
      setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); resolve({ error: 'the screen took too long to start' }); } }, 15_000);
    });
    if (result.error) throw new Error(result.error);
    active = { from, displayId: scr.displayId, control: !!s.control, since: Date.now() };
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

  return {
    start, end,
    screens,
    status: () => ({ active: !!active, from: active ? active.from : '', control: !!(active && active.control) }),
    canControl: () => input.available(),
    // the settings changed: switched off means the session ends now
    settingsChanged() {
      const s = getSettings();
      if (active && !s.view) end('switched off on the stream PC');
      else if (active && active.control && !s.control) { input.releaseAll(); active.control = false; showBar(`${active.from} is watching this PC`); onChange(); }
    },
    stop() { end('Stagelight closed'); input.stop(); hideBar(); if (capture && !capture.isDestroyed()) capture.destroy(); },
  };
}

module.exports = { createRemote, QUALITY };
