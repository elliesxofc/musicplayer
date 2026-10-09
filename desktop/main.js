'use strict';

/* moonlit desktop: the same player as the website, as a real app.
   It serves the web files from inside the app (no internet needed), and adds a
   few things a browser can't do: write the OBS now-playing file without asking
   for permission every time, never get put to sleep, and start with the PC. */

const { app, BrowserWindow, protocol, net, session, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const ORIGIN = 'moonlit://app';
// Only the player's own files are served to the window.
const SERVED = new Set(['index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'sw.js']);
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

/* ───────────── one window, one player ───────────── */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;

  // opening moonlit (or a song) while it's already running: use this window
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
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
      icon: path.join(ROOT, 'icons', 'icon-512.png'),
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

    const remember = () => {
      if (!win || win.isMinimized()) return;
      writeConfig({ window: { ...win.getNormalBounds(), maximized: win.isMaximized() } });
    };
    win.on('resize', remember);
    win.on('move', remember);
    win.on('close', remember);
    win.on('closed', () => { win = null; });

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
ipcMain.handle('dl:list', () => dl().list());
ipcMain.handle('dl:cancel', (_e, id) => dl().cancel(Number(id)));
ipcMain.handle('dl:retry', (_e, id) => dl().retry(Number(id)));
ipcMain.handle('dl:cancel-all', () => dl().cancelAll());
ipcMain.handle('dl:clear', () => dl().clearFinished());
ipcMain.handle('dl:folder', () => dl().folder());
ipcMain.handle('dl:choose-folder', () => dl().chooseFolder());
ipcMain.handle('dl:open-folder', () => dl().openFolder());
app.on('before-quit', () => { if (downloader) downloader.stopAll(); });

/* ───────────── now-playing overlay for OBS (http://localhost:4848/overlay) ───────────── */
const overlay = require('./overlay').createOverlay();
const overlayReady = app.whenReady().then(() => overlay.start());
ipcMain.on('overlay:state', (_e, s) => { if (s && typeof s === 'object') overlay.update(s); });
ipcMain.on('overlay:cover', (_e, id, type, bytes) => overlay.setCover(id, type, bytes));
ipcMain.handle('overlay:url', async () => { await overlayReady; return overlay.url(); });
ipcMain.handle('overlay:open', async (_e, url) => { if (/^http:\/\/localhost:\d+\/overlay/.test(url)) shell.openExternal(url); });
app.on('before-quit', () => overlay.stop());
