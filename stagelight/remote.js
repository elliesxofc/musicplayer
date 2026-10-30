'use strict';

/* The remote display (the whole PC, like AnyDesk or Parsec), from the panel.

   Off unless switched on in Stagelight on the stream PC; mouse and keyboard is a second
   switch. While someone is connected, a small bar shows at the top of the screen (with a
   button to stop it), and Windows shows a notification. One person at a time. */

const { BrowserWindow, desktopCapturer, screen, Notification, ipcMain, session, powerSaveBlocker } = require('electron');
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

/* The stream PC's processor comes first too. When the picture is made by the processor (no
   graphics card encoder), it's kept at 15 fps and at most about 720p; when the PC as a whole is
   busy (85% or more for a few seconds), it drops to 10 fps and a smaller picture until the PC has
   calmed down. */
const SOFT = { fps: 15, height: 720 };
const HOT = { fps: 10, height: 540, bitrate: 1_000_000 };

// the most upload the stream PC lets the picture use (set in Stagelight, 0 = no limit), on top
function limitFor(q, stream, guard, now = Date.now(), max = 0, cpu = {}) {
  const l = liveLimit(q, stream, guard, now);
  l.scale = 1;
  if (cpu.soft) { l.fps = Math.min(l.fps, SOFT.fps); l.scale = Math.max(1, q.height / SOFT.height); }
  if (cpu.hot) {
    l.fps = Math.min(l.fps, HOT.fps); l.scale = Math.max(l.scale, q.height / HOT.height); l.bitrate = Math.min(l.bitrate, HOT.bitrate);
    l.saving = true; l.level = 'hot';
  }
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
  full: (l, was) => (was === 'capped' ? 'no upload limit any more: full picture again' : was === 'hot' ? 'the stream PC has calmed down: full picture again' : 'the stream ended: full picture again'),
  capped: l => `the stream PC lets the picture use up to ${mbps(l.bitrate)} of its upload`,
  hot: 'the stream PC is busy: the picture is lowered so OBS keeps its processor',
  live: "you're live: the picture is kept light so the stream keeps its upload",
  low: 'the stream is struggling: the picture is lowered to give it room',
};

const note = (l, was) => (typeof NOTES[l.level] === 'function' ? NOTES[l.level](l, was) : NOTES[l.level]);

function createRemote({ root, icon, getSettings, log = () => {}, onChange = () => {}, onStarted = () => {} }) {
  let capture = null, bar = null, active = null, nextJob = 1, closeTimer = null, stream = null;
  // the screen stays on while someone is connected: a display that went to sleep isn't drawn any
  // more, so the remote display would keep showing the last picture from before it slept
  let awake = null;
  const keepAwake = on => {
    if (on && awake === null) awake = powerSaveBlocker.start('prevent-display-sleep');
    else if (!on && awake !== null) { powerSaveBlocker.stop(awake); awake = null; }
  };
  const cpu = { hot: false, soft: false }; // the PC is busy / the picture is made by the processor
  const waiting = new Map(); // job id → resolve
  // clicks and keys into a program run as administrator are dropped by Windows: say so (once a while)
  let blockedSaid = { name: '', at: 0 };
  const input = createInput({ log, onBlocked: name => {
    if (!active || (blockedSaid.name === name && Date.now() - blockedSaid.at < 20_000)) return;
    blockedSaid = { name, at: Date.now() };
    const text = `Windows blocks clicks and keys into ${name} (it runs as administrator). run Stagelight as administrator on the stream PC, or ${name} normally.`;
    log(`remote display: clicks into ${name} are blocked (it runs as administrator; Stagelight doesn't)`);
    if (active.relay) relaySay({ t: 'note', text });
    else if (capture && !capture.isDestroyed()) capture.webContents.send('note', text);
  } });

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
  // which encoder makes the picture: the graphics card's, or the processor (software)
  ipcMain.on('encoder', (e, info) => {
    if (!active || !capture || e.sender !== capture.webContents || !info) return;
    const soft = !info.hardware;
    log(`remote display: the picture is made by ${soft ? 'the processor' : 'the graphics card'} (${String(info.name || 'unknown').slice(0, 80)})${soft ? ', so it is kept at 15 fps' : ''}`);
    if (soft !== cpu.soft) { cpu.soft = soft; streamChanged(stream); }
  });
  /* ───────────── through the web address: pictures out, mouse and keyboard in ─────────────
     Each message to the panel: 1 byte kind (1 picture, 2 a note as JSON, 0 still here),
     4 bytes length, then the bytes. A slow phone gets the newest picture, not a queue. */
  const relayOut = { seq: 0, buf: null, note: '', watchers: new Set() };
  const packet = (kind, body = Buffer.alloc(0)) => { const h = Buffer.alloc(5); h[0] = kind; h.writeUInt32BE(body.length, 1); return Buffer.concat([h, body]); };
  function relayPush(w) {
    if (w.busy || !relayOut.buf || w.sent === relayOut.seq) return;
    w.sent = relayOut.seq;
    if (!w.res.write(packet(1, relayOut.buf))) w.busy = true;
  }
  function relaySay(msg) { for (const w of relayOut.watchers) w.res.write(packet(2, Buffer.from(JSON.stringify(msg)))); }
  function relayClose(why) {
    relaySay({ t: 'end', why });
    for (const w of relayOut.watchers) w.res.end();
    relayOut.watchers.clear(); relayOut.buf = null;
  }
  ipcMain.on('frame', (e, data) => {
    if (!active || !active.relay || !capture || e.sender !== capture.webContents) return;
    relayOut.buf = Buffer.from(data); relayOut.seq++;
    for (const w of relayOut.watchers) relayPush(w);
  });
  setInterval(() => { for (const w of relayOut.watchers) if (!w.busy) w.res.write(packet(0)); }, 20_000).unref(); // keeps the web address from closing a quiet line
  // the panel that started it (its login) watches; false if that's not this session
  const relayAllowed = owner => !!(active && active.relay && active.owner === owner);
  function relayWatch(res, owner) {
    if (!relayAllowed(owner)) return false;
    const w = { res, sent: 0, busy: false };
    relayOut.watchers.add(w);
    res.on('drain', () => { w.busy = false; relayPush(w); });
    res.on('close', () => relayOut.watchers.delete(w));
    if (relayOut.note) { res.write(packet(2, Buffer.from(JSON.stringify({ t: 'note', text: relayOut.note })))); relayOut.note = ''; }
    relayPush(w);
    return true;
  }
  function relayInput(owner, msg) {
    if (!active || !active.relay || active.owner !== owner) return false;
    handleInput(msg);
    return true;
  }

  ipcMain.on('bar-stop', () => end('stopped on the stream PC'));
  ipcMain.on('input', (e, msg) => {
    if (!capture || e.sender !== capture.webContents) return;
    handleInput(msg);
  });

  /* ───────────── start / end ───────────── */
  async function start({ sdp, screenId, quality, from, ice = [], relay = false, owner = '' }) {
    const s = getSettings();
    if (!s.view) throw new Error('the remote display is switched off in Stagelight on the stream PC');
    if (!relay && (typeof sdp !== 'string' || sdp.length > 100_000 || !/^v=0/.test(sdp))) throw new Error('bad request');
    const list = await screens();
    const scr = list.find(x => x.id === screenId) || list[0];
    if (!scr) throw new Error("couldn't find a screen to share");
    // the same panel switching (to the web address, another screen or picture): no goodbye needed
    if (active && owner && active.owner === owner) { relayClose('switching'); active.quiet = true; end(''); }
    else if (active) end('someone else connected');
    clearTimeout(closeTimer);
    const q = QUALITY[quality] || QUALITY.smooth;
    const guard = {};
    cpu.soft = false; // found out again for each session
    const limit = limitFor(q, stream, guard, Date.now(), s.max, cpu);
    if (limit.level !== 'full') limit.note = note(limit);
    const id = nextJob++;
    const win = captureWindow();
    if (win.webContents.isLoading()) await new Promise(r => win.webContents.once('did-finish-load', r));
    const result = await new Promise(resolve => {
      waiting.set(id, resolve);
      win.webContents.send('start', { id, sourceId: scr.id, offer: sdp, ice, relay, ...q, limit });
      setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); resolve({ error: 'the screen took too long to start' }); } }, 15_000);
    });
    if (result.error) throw new Error(result.error);
    active = { from, displayId: scr.displayId, control: !!s.control, since: Date.now(), q, guard, level: limit.level, bitrate: limit.bitrate, fps: limit.fps, scale: limit.scale, relay, owner };
    relayOut.buf = null; relayOut.note = relay && limit.note ? limit.note : '';
    keepAwake(true);
    onStarted();
    const what = active.control ? 'controlling' : 'watching';
    log(`remote display: ${from} is ${what} this PC${relay ? ' (through the web address)' : ''}`);
    showBar(`${from} is ${what} this PC`);
    if (Notification.isSupported()) new Notification({ title: 'Stagelight: remote display on', body: `${from} is ${what} this PC through the panel.`, icon }).show();
    onChange();
    return { sdp: result.sdp, control: active.control, relay };
  }

  function end(why = '') {
    if (!active) return;
    relayClose(why || 'ended on the stream PC');
    input.releaseAll();
    if (capture && !capture.isDestroyed()) capture.webContents.send('stop', why);
    if (!active.quiet) log(`remote display ended${why ? ` (${why})` : ''}`);
    active = null;
    keepAwake(false);
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
    const limit = limitFor(active.q, stream, active.guard, Date.now(), getSettings().max, cpu);
    if (limit.level === active.level && limit.bitrate === active.bitrate && limit.fps === active.fps && limit.scale === active.scale) return;
    if (limit.level === 'low' && active.level !== 'low') log('remote display: the stream is struggling, the picture is lowered');
    const was = active.level, wasRate = active.bitrate;
    Object.assign(active, { level: limit.level, bitrate: limit.bitrate, fps: limit.fps, scale: limit.scale });
    // a note for the panel only when the reason changes (not for a quieter tweak, like the encoder found out)
    if (active.relay && (limit.level !== was || (limit.level === 'capped' && limit.bitrate !== wasRate))) relaySay({ t: 'note', text: note(limit, was) });
    capture.webContents.send('limit', { ...limit, note: limit.level !== was || (limit.level === 'capped' && limit.bitrate !== wasRate) ? note(limit, was) : undefined });
  }

  // the PC as a whole is busy (or not any more)
  function cpuBusy(hot) {
    if (hot === cpu.hot) return;
    cpu.hot = hot;
    if (active) streamChanged(stream);
  }

  return {
    start, end, streamChanged, cpuBusy, relayWatch, relayInput, relayAllowed,
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
