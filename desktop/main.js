'use strict';

/* moonlit desktop: the same player as the website, as a real app.
   It serves the web files from inside the app (no internet needed), and adds a
   few things a browser can't do: write the OBS now-playing file without asking
   for permission every time, never get put to sleep, and start with the PC. */

const { app, BrowserWindow, protocol, net, session, ipcMain, dialog, shell, Menu, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { createTray } = require('./tray');

const ROOT = path.join(__dirname, '..');
const ORIGIN = 'moonlit://app';
// Only the player's own files are served to the window.
const SERVED = new Set(['index.html', 'style.css', 'vizcore.js', 'app.js', 'obs.js', 'live.js', 'requests.js', 'manifest.webmanifest', 'sw.js']);
const SERVED_DIRS = ['icons'];

protocol.registerSchemesAsPrivileged([
  { scheme: 'moonlit', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

/* ───────────── songs opened from Windows (double-click / Open with) ───────────── */
const AUDIO_RE = /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|webm|weba|aiff?)$/i;
const opened = new Set(); // only files Windows handed us may be read
let pendingFiles = [];

function audioFilesIn(argv) {
  return argv.slice(1)
    .filter(a => !a.startsWith('-') && AUDIO_RE.test(a))
    .map(a => path.resolve(a))
    .filter(a => { try { return fs.statSync(a).isFile(); } catch { return false; } });
}
function acceptFiles(files) {
  files.forEach(f => opened.add(f));
  return files;
}
pendingFiles = acceptFiles(audioFilesIn(process.argv));
// macOS hands files over with an event instead
app.on('open-file', (e, file) => {
  e.preventDefault();
  if (!AUDIO_RE.test(file)) return;
  acceptFiles([file]);
  const w = BrowserWindow.getAllWindows()[0];
  if (w) w.webContents.send('files:open', [file]); else pendingFiles.push(file);
});

/* ───────────── small settings file in the app's data folder ───────────── */
const configPath = () => path.join(app.getPath('userData'), 'desktop.json');
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}
function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  try { fs.writeFileSync(configPath(), JSON.stringify(next, null, 2)); } catch { /* read-only disk */ }
  return next;
}

/* ───────────── the app's icon in the theme's colours (when "match the icon" is on) ───────────── */
const iconTheme = () => { const t = readConfig().iconTheme; return typeof t === 'string' && /^[a-z-]{1,40}$/.test(t) ? t : null; };
function themedIcon(size) {
  const t = iconTheme();
  const file = t && path.join(ROOT, 'icons', 'themes', `${t}-${size}.png`);
  return file && fs.existsSync(file) ? file : path.join(ROOT, 'icons', size <= 192 ? 'icon-192.png' : 'icon-512.png');
}
// a Windows .ico (PNG inside) for the taskbar button
function writeIco(file, pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, at);
    head.writeUInt8(size >= 256 ? 0 : size, at + 1);
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(data.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  fs.writeFileSync(file, Buffer.concat([head, ...pngs.map(p => p.data)]));
}
function applyIcon(win) {
  if (!win || win.isDestroyed()) return;
  const { nativeImage } = require('electron');
  const img = nativeImage.createFromPath(themedIcon(512));
  if (img.isEmpty()) return;
  win.setIcon(img);
  if (process.platform !== 'win32') return;
  // Windows takes the taskbar button's picture from an .ico, so one is made for the theme
  try {
    const t = iconTheme() || 'default';
    const ico = path.join(app.getPath('userData'), `taskbar-${t}.ico`);
    if (!fs.existsSync(ico)) writeIco(ico, [256, 48, 32, 16].map(size => ({ size, data: img.resize({ width: size, height: size, quality: 'best' }).toPNG() })));
    win.setAppDetails({ appId: 'io.github.elliesxofc.moonlit', appIconPath: ico, appIconIndex: 0, relaunchCommand: `"${process.execPath}"`, relaunchDisplayName: 'moonlit' });
  } catch { /* the window icon is still set */ }
}

/* ───────────── one window, one player ───────────── */
// Windows shows notifications under this name (the same id the installer gives the app)
if (process.platform === 'win32') app.setAppUserModelId('io.github.elliesxofc.moonlit');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;

  // the tray icon, hiding to it, and the "now playing" notification
  const tray = createTray({
    root: ROOT,
    iconFile: () => themedIcon(192),
    getWindow: () => win,
    send: (channel, ...args) => { if (win) win.webContents.send(channel, ...args); },
    load: () => readConfig().tray || {},
    save: settings => writeConfig({ tray: settings }),
  });
  // the theme changed (or "match the icon" was switched): theme id, or null for the usual icon
  ipcMain.handle('app:icon', (_e, theme) => {
    const next = typeof theme === 'string' && /^[a-z-]{1,40}$/.test(theme) && fs.existsSync(path.join(ROOT, 'icons', 'themes', `${theme}-512.png`)) ? theme : null;
    if (next === iconTheme()) return next;
    writeConfig({ iconTheme: next });
    applyIcon(win);
    tray.refreshIcon();
    return next;
  });
  ipcMain.handle('tray:get', () => tray.get());
  ipcMain.handle('tray:set', (_e, patch) => tray.set({
    ...(patch && 'tray' in patch ? { tray: !!patch.tray } : {}),
    ...(patch && 'notify' in patch ? { notify: !!patch.notify } : {}),
    ...(patch && 'notifyAlways' in patch ? { notifyAlways: !!patch.notifyAlways } : {}),
  }));
  ipcMain.on('tray:now-playing', (_e, songInfo) => tray.nowPlaying(songInfo && typeof songInfo === 'object' ? songInfo : null));
  ipcMain.on('tray:playing', (_e, on) => tray.setPlaying(!!on));

  // opening moonlit (or a song) while it's already running: use this window
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    tray.show(); // also brings it back from the tray
    const files = acceptFiles(audioFilesIn(argv));
    if (files.length) win.webContents.send('files:open', files);
  });

  function createWindow() {
    const saved = readConfig().window || {};
    win = new BrowserWindow({
      width: saved.width || 1280,
      height: saved.height || 800,
      x: saved.x,
      y: saved.y,
      minWidth: 360,
      minHeight: 560,
      title: 'moonlit',
      backgroundColor: '#170a14',
      icon: themedIcon(512),
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        // keep playing at full speed when minimized or covered by OBS
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    if (saved.maximized) win.maximize();
    win.once('ready-to-show', () => win.show());
    if (iconTheme()) applyIcon(win);

    const remember = () => {
      if (!win || win.isMinimized()) return;
      writeConfig({ window: { ...win.getNormalBounds(), maximized: win.isMaximized() } });
    };
    win.on('resize', remember);
    win.on('move', remember);
    win.on('close', remember);
    win.on('closed', () => { win = null; });
    tray.attach(win);
    // "Do you want to close the program?": the page shows its own popup and answers. If it
    // doesn't answer in a moment (stuck), moonlit closes anyway; Windows shutting down never asks.
    let closeOk = false, asking = false, askTimer = 0;
    win.on('close', e => {
      if (closeOk) return;
      if (tray.get().tray && !tray.quitting()) return; // the tray hides it instead
      e.preventDefault();
      if (asking) return;
      asking = true;
      tray.show();
      win.webContents.send('app:close-request');
      askTimer = setTimeout(() => { closeOk = true; app.quit(); }, 2500);
    });
    ipcMain.removeAllListeners('app:close-seen');
    ipcMain.removeAllListeners('app:close-answer');
    ipcMain.on('app:close-seen', () => clearTimeout(askTimer)); // the popup is up: wait for the answer
    ipcMain.on('app:close-answer', (_e, yes) => {
      clearTimeout(askTimer);
      asking = false;
      if (yes) { closeOk = true; app.quit(); } else tray.cancelQuit();
    });
    const shuttingDown = () => { closeOk = true; };
    win.on('session-end', shuttingDown);
    win.on('query-session-end', shuttingDown);
    // moonlit never slows down in the background (so music never stutters), which also means
    // the page can't tell when nobody sees it; say so, so the pretty animations can rest
    const seen = on => () => { if (win) win.webContents.send('app:visible', on); };
    win.on('hide', seen(false)); win.on('minimize', seen(false));
    win.on('show', seen(true)); win.on('restore', seen(true));

    // links (e.g. the VB-CABLE site) open in your normal browser
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith(ORIGIN)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
    });

    win.loadURL(`${ORIGIN}/index.html`);
  }

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);

    protocol.handle('moonlit', req => {
      const { pathname } = new URL(req.url);
      const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
      const top = rel.split('/')[0];
      const file = path.normalize(path.join(ROOT, rel));
      const inside = file.startsWith(ROOT + path.sep);
      if (!inside || !(SERVED.has(rel) || SERVED_DIRS.includes(top))) {
        return new Response('not found', { status: 404 });
      }
      return net.fetch(pathToFileURL(file).toString());
    });

    // microphone permission is only used to read sound-output device names
    // (for the virtual cable picker); nothing is ever recorded
    const allowed = new Set(['media', 'speaker-selection', 'fileSystem', 'clipboard-sanitized-write']);
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
      const videoAsked = (details.mediaTypes || []).includes('video');
      callback(allowed.has(permission) && !videoAsked);
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission) => allowed.has(permission));

    createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });

  app.on('window-all-closed', () => app.quit());
}

/* ───────────── things the page can ask the app to do ───────────── */

// OBS now-playing file: picked once, remembered, written directly.
ipcMain.handle('obs:choose', async () => {
  const current = readConfig().nowPlayingPath;
  const res = await dialog.showSaveDialog({
    title: 'Where should moonlit save the song name for OBS?',
    defaultPath: current || path.join(app.getPath('documents'), 'nowplaying.txt'),
    filters: [{ name: 'Text file', extensions: ['txt'] }],
  });
  if (res.canceled || !res.filePath) return null;
  writeConfig({ nowPlayingPath: res.filePath });
  return { path: res.filePath, name: path.basename(res.filePath) };
});

ipcMain.handle('obs:get', () => {
  const p = readConfig().nowPlayingPath;
  return p ? { path: p, name: path.basename(p) } : null;
});

ipcMain.handle('obs:unlink', () => { writeConfig({ nowPlayingPath: null }); return true; });

ipcMain.handle('obs:write', async (_e, text) => {
  const p = readConfig().nowPlayingPath;
  if (!p || typeof text !== 'string') return false;
  try {
    await fs.promises.writeFile(p, text.slice(0, 2000), 'utf8');
    return true;
  } catch {
    return false;
  }
});

// Start with Windows / macOS login.
ipcMain.handle('startup:get', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('startup:set', (_e, on) => {
  app.setLoginItemSettings({ openAtLogin: !!on });
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle('app:version', () => app.getVersion());

// Songs opened from Windows: the page asks for the list once it's ready,
// then reads each one. Only files Windows gave us can be read.
ipcMain.handle('files:pending', () => { const f = pendingFiles; pendingFiles = []; return f; });
ipcMain.handle('files:read', async (_e, file) => {
  if (!opened.has(file)) return null;
  try {
    const [data, st] = await Promise.all([fs.promises.readFile(file), fs.promises.stat(file)]);
    return { name: path.basename(file), data, lastModified: st.mtimeMs };
  } catch {
    return null;
  }
});

/* ───────────── playlist files (.m3u8 / .m3u) ───────────── */
// import: the file's text, plus the songs it points to that are on this PC (so they can be
// added to the library: only these, the ones the playlist you picked names, may be read)
ipcMain.handle('playlist:open', async e => {
  const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    title: 'import a playlist',
    filters: [{ name: 'playlists', extensions: ['m3u8', 'm3u'] }, { name: 'all files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  const file = !res.canceled && res.filePaths[0];
  if (!file) return null;
  const buf = fs.readFileSync(file);
  if (buf.length > 5_000_000) return { error: "that file is too big to be a playlist" };
  let text = buf.toString('utf8').replace(/^\uFEFF/, '');
  if (text.includes('\uFFFD')) text = buf.toString('latin1'); // an old .m3u in the Windows code page
  const dir = path.dirname(file), files = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let p = line;
    if (/^file:/i.test(p)) { try { p = fileURLToPath(p); } catch { continue; } }
    else if (/^[a-z][a-z0-9+.-]+:\/\//i.test(p)) continue; // web links
    const abs = path.resolve(dir, p);
    try { if (AUDIO_RE.test(abs) && fs.statSync(abs).isFile()) { opened.add(abs); files[line] = abs; } } catch { /* not on this PC */ }
  }
  return { name: path.basename(file).replace(/\.m3u8?$/i, ''), text, files };
});
// export: save the playlist where you choose (your Music folder to start with)
ipcMain.handle('playlist:save', async (e, name, text) => {
  const safe = String(name || 'playlist').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').trim().slice(0, 120) || 'playlist';
  const res = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
    title: 'save the playlist',
    defaultPath: path.join(app.getPath('music'), `${safe}.m3u8`),
    filters: [{ name: 'playlist', extensions: ['m3u8'] }],
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, String(text || '').slice(0, 20_000_000), 'utf8');
  return res.filePath;
});

/* ───────────── downloader (YouTube / Spotify links → songs) ───────────── */
let downloader = null;
function dl() {
  if (!downloader) {
    const { createDownloader } = require('./downloader');
    downloader = createDownloader({
      send: (channel, payload) => BrowserWindow.getAllWindows().forEach(w => w.webContents.send(channel, payload)),
      readConfig,
      writeConfig,
      allowRead: file => opened.add(file), // so the page can add finished songs to the library
    });
  }
  return downloader;
}
ipcMain.handle('dl:add', (_e, url, format) => dl().add(url, format));
ipcMain.handle('dl:add-list', (_e, text, format) => dl().addList(String(text || '').slice(0, 20_000_000), format));
ipcMain.handle('dl:list', () => dl().list());
ipcMain.handle('dl:cancel', (_e, id) => dl().cancel(Number(id)));
ipcMain.handle('dl:retry', (_e, id) => dl().retry(Number(id)));
ipcMain.handle('dl:cancel-all', () => dl().cancelAll());
ipcMain.handle('dl:clear', () => dl().clearFinished());
ipcMain.handle('dl:folder', () => dl().folder());
ipcMain.handle('dl:choose-folder', () => dl().chooseFolder());
ipcMain.handle('dl:open-folder', () => dl().openFolder());
ipcMain.handle('dl:forget-request', (_e, file) => dl().forgetRequest(String(file || '')));
ipcMain.handle('dl:request-files', () => dl().requestFiles());
ipcMain.handle('dl:request', (_e, query, rules) => dl().request(String(query || ''), {
  channels: Array.isArray(rules && rules.channels) ? rules.channels.map(String).slice(0, 200) : [],
  anyChannel: !!(rules && rules.anyChannel),
  maxSeconds: Math.max(60, Math.min(3600, Number(rules && rules.maxSeconds) || 600)),
  blocked: Array.isArray(rules && rules.blocked) ? rules.blocked.map(String).slice(0, 500) : [],
}));
// the song request channel list: a pasted channel link, @handle or video link → the channel's ID
ipcMain.handle('channels:resolve', (_e, input) => require('./channels').resolveChannel(String(input || '').slice(0, 500), {
  fetchImpl: (u, o) => net.fetch(u, o),
  fallback: (u, kind) => dl().channelOf(u, kind),
}));
app.on('before-quit', () => { if (downloader) downloader.stopAll(); });

/* ───────────── now-playing overlay for OBS (http://localhost:4848/overlay) ───────────── */
const overlay = require('./overlay').createOverlay();
const overlayReady = app.whenReady().then(() => overlay.start());
ipcMain.on('overlay:state', (_e, s) => { if (s && typeof s === 'object') overlay.update(s); });
ipcMain.on('overlay:cover', (_e, id, type, bytes) => overlay.setCover(id, type, bytes));
ipcMain.on('overlay:spectrum', (_e, levels) => overlay.spectrum(levels));
overlay.onWatchers(n => BrowserWindow.getAllWindows().forEach(w => w.webContents.send('overlay:watchers', n)));
ipcMain.handle('overlay:url', async () => { await overlayReady; return overlay.url(); });
ipcMain.handle('overlay:open', async (_e, url) => { if (/^http:\/\/localhost:\d+\/overlay/.test(url)) shell.openExternal(url); });
app.on('before-quit', () => overlay.stop());

/* ───────────── secrets kept in desktop.json, encrypted with Windows' own protection ───────────── */
function seal(text) {
  if (!text) return null;
  if (safeStorage.isEncryptionAvailable()) return { enc: safeStorage.encryptString(text).toString('base64') };
  return { plain: text };
}
function unseal(box) {
  if (!box) return '';
  try { return box.enc ? safeStorage.decryptString(Buffer.from(box.enc, 'base64')) : box.plain || ''; } catch { return ''; }
}
const sendAll = (channel, payload) => BrowserWindow.getAllWindows().forEach(w => w.webContents.send(channel, payload));

/* ───────────── !nowplaying in YouTube chat ───────────── */
const chat = require('./chat').createChat({
  nowPlaying: () => overlay.now(),
  onStatus: s => sendAll('chat:status', s),
  onCommand: c => sendAll('chat:command', c),
});
function chatSettings() {
  const c = readConfig().chat || {};
  return { enabled: !!c.enabled, stream: c.stream || '', login: unseal(c.login) };
}
app.whenReady().then(() => chat.start(chatSettings()));
ipcMain.handle('chat:get', () => {
  const s = chatSettings();
  return { enabled: s.enabled, stream: s.stream, hasLogin: !!s.login, status: chat.status() };
});
// login: a new value to save, '' to forget it, or left out to keep the saved one
ipcMain.handle('chat:set', (_e, next) => {
  if (!next || typeof next !== 'object') return null;
  const c = { ...(readConfig().chat || {}) };
  if (typeof next.enabled === 'boolean') c.enabled = next.enabled;
  if (typeof next.stream === 'string') c.stream = next.stream.trim().slice(0, 300);
  if (typeof next.login === 'string') c.login = seal(next.login.trim());
  writeConfig({ chat: c });
  chat.start(chatSettings());
  return chat.status();
});
ipcMain.handle('chat:preview', () => chat.preview());
ipcMain.on('chat:say', (_e, text) => { if (typeof text === 'string') chat.say(text.slice(0, 1000)); });
app.on('before-quit', () => chat.stop());

/* ───────────── Spotify's now playing ─────────────
   Two ways: the Spotify app on this PC through Windows' media controls (free, no setup,
   the default on Windows), or a connected Spotify account through Spotify's Web API
   (Spotify only allows that with Premium). A connected account wins when there is one. */
let spotify = null;
const winmedia = require('./winmedia').createWinMedia({
  onState: s => { spotifyStates.local = s; publishSpotify(); },
  onStatus: s => sendAll('spotify:local-status', s),
  onCover: (id, type, bytes) => overlay.setCover(id, type, bytes),
});
const spotifyStates = { web: null, local: null };
const useWeb = () => !!(spotify && spotify.info().connected);
const currentSpotify = () => (useWeb() ? spotifyStates.web : spotifyStates.local);
function publishSpotify() { sendAll('spotify:state', currentSpotify()); }
const localOn = () => winmedia.available() && readConfig().spotifyLocal !== false;

app.whenReady().then(() => {
  // created once the app is ready: reading the saved (encrypted) login needs that
  spotify = require('./spotify').createSpotify({
    load: () => { const s = readConfig().spotify || {}; return { clientId: s.clientId || '', refresh: unseal(s.refresh) }; },
    save: a => writeConfig({ spotify: { clientId: a.clientId || '', refresh: seal(a.refresh || '') } }),
    openBrowser: url => shell.openExternal(url),
    onState: s => { spotifyStates.web = s; publishSpotify(); },
    onStatus: s => sendAll('spotify:status', s),
    onCover: (id, type, bytes) => overlay.setCover(id, type, bytes),
  });
  if (localOn()) winmedia.start();
});
ipcMain.handle('spotify:get', () => (spotify ? { ...spotify.info(), state: currentSpotify(), local: { ...winmedia.info(), on: localOn() } } : null));
ipcMain.handle('spotify:connect', async (_e, clientId) => {
  try { await spotify.connect(clientId); return { ok: true }; } catch (err) { return { ok: false, message: err.message }; }
});
ipcMain.handle('spotify:control', (_e, action) => (useWeb() ? spotify.control(String(action)) : winmedia.control(String(action))));
ipcMain.handle('spotify:disconnect', () => { spotify.disconnect(); publishSpotify(); });
ipcMain.handle('spotify:local', (_e, on) => {
  writeConfig({ spotifyLocal: !!on });
  if (localOn()) winmedia.start(); else winmedia.stop();
  return { ...winmedia.info(), on: localOn() };
});
ipcMain.handle('spotify:open', (_e, url) => { if (/^https:\/\/(open|developer)\.spotify\.com\//.test(url)) shell.openExternal(url); });
app.on('before-quit', () => { if (spotify) spotify.stop(); winmedia.stop(); });
