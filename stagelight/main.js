'use strict';

/* Stagelight: a remote control for OBS in any browser.
   Runs on the stream PC (in the tray, by the clock), talks to OBS there, and serves a
   password-protected panel to phones, tablets and other PCs on the same network, or from
   anywhere through Tailscale. */

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createObs } = require('./obs');
const { createServer, hashPassword } = require('./server');

const ROOT = __dirname;
const ICON = path.join(ROOT, 'icons', 'icon-256.png');

app.setName('Stagelight'); // its own settings folder, apart from moonlit's
if (process.platform === 'win32') app.setAppUserModelId('io.github.elliesxofc.stagelight');
if (!app.requestSingleInstanceLock()) { app.quit(); return; }

/* ───────────── settings file (the OBS password is encrypted, the panel password hashed) ───────────── */
const configPath = () => path.join(app.getPath('userData'), 'stagelight.json');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; } };
function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  try { fs.mkdirSync(path.dirname(configPath()), { recursive: true }); fs.writeFileSync(configPath(), JSON.stringify(next, null, 2)); } catch { /* read-only disk */ }
  return next;
}
const seal = text => (text && safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(text).toString('base64')}` : text || '');
const unseal = text => {
  if (!text || !String(text).startsWith('enc:')) return text || '';
  try { return safeStorage.decryptString(Buffer.from(String(text).slice(4), 'base64')); } catch { return ''; }
};
const obsSettings = () => { const o = readConfig().obs || {}; return { host: o.host || 'localhost', port: Number(o.port) || 4455, password: unseal(o.password) }; };
const panelPort = () => Math.max(1024, Math.min(65535, Number(readConfig().port) || 4850));

/* ───────────── the addresses other devices open ───────────── */
function addresses() {
  const port = server.port() || panelPort();
  const list = [];
  for (const [name, nets] of Object.entries(os.networkInterfaces())) {
    for (const n of nets || []) {
      if (n.family !== 'IPv4' || n.internal) continue;
      const [a, b] = n.address.split('.').map(Number);
      const tailscale = /tailscale/i.test(name) || (a === 100 && b >= 64 && b <= 127);
      if (!tailscale && !(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) continue; // home networks only
      list.push({ url: `http://${n.address}:${port}`, kind: tailscale ? 'tailscale' : 'home', name });
    }
  }
  return list.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === 'home' ? -1 : 1));
}

/* ───────────── OBS + the panel's server ───────────── */
let win = null, tray = null, quitting = false;
const sendWin = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };
const logLines = [];
const log = line => {
  const entry = `${new Date().toLocaleTimeString()}  ${line}`;
  logLines.push(entry);
  if (logLines.length > 60) logLines.shift();
  sendWin('log', entry);
};

const obs = createObs({ onChange: snap => { server.broadcast(snap); sendWin('status', status()); refreshTray(); }, log });
const server = createServer({ obs, getPassword: () => readConfig().panelPassword || null, log });

function status() {
  const s = obs.snapshot();
  return { obs: s.status, connected: s.connected, live: s.stream.active, recording: s.record.active, sessions: server.sessionCount(), port: server.port(), addresses: addresses() };
}

async function startServer() {
  try {
    await server.start(panelPort());
    log(`panel ready on port ${server.port()}`);
  } catch (err) {
    log(`couldn't open the panel on port ${panelPort()} (${err.code === 'EADDRINUSE' ? 'another program uses it, pick another port' : err.message})`);
  }
  sendWin('status', status());
}

/* ───────────── window + tray ───────────── */
function showWindow() {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 560, height: 760, minWidth: 420, minHeight: 520, show: false, autoHideMenuBar: true,
    title: 'Stagelight', backgroundColor: '#0d0b1a', icon: ICON,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.loadFile(path.join(ROOT, 'settings.html'));
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  // closing the window keeps Stagelight running in the tray (the panel keeps working)
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });
}

function refreshTray() {
  if (!tray) return;
  const s = obs.snapshot();
  const what = !s.connected ? 'OBS not connected' : s.stream.active ? 'live' : s.record.active ? 'recording' : 'OBS connected';
  tray.setToolTip(`Stagelight · ${what}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Stagelight · ${what}`, enabled: false },
    { type: 'separator' },
    { label: 'open the panel here', click: () => shell.openExternal(`http://localhost:${server.port() || panelPort()}`) },
    { label: 'settings', click: showWindow },
    { type: 'separator' },
    { label: 'quit Stagelight', click: () => { quitting = true; app.quit(); } },
  ]));
}

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; obs.stop(); server.stop(); });
app.on('window-all-closed', () => { /* stays in the tray */ });

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 32, height: 32 }));
  tray.on('click', showWindow);
  refreshTray();
  showWindow();
  await startServer();
  if (readConfig().obs) obs.start(obsSettings());
  else log('add OBS\'s WebSocket details to connect');
});

/* ───────────── the settings window asks ───────────── */
ipcMain.handle('get', () => {
  const c = readConfig();
  const o = obsSettings();
  return {
    obs: { host: o.host, port: o.port, hasPassword: !!o.password },
    hasPanelPassword: !!c.panelPassword,
    port: panelPort(),
    autostart: app.getLoginItemSettings().openAtLogin,
    status: status(),
    log: logLines,
  };
});
ipcMain.handle('set-obs', (_e, next) => {
  if (!next || typeof next !== 'object') return status();
  const o = { ...(readConfig().obs || {}) };
  o.host = String(next.host || 'localhost').trim().slice(0, 200) || 'localhost';
  o.port = Math.max(1, Math.min(65535, Number(next.port) || 4455));
  if (typeof next.password === 'string') o.password = seal(next.password);
  writeConfig({ obs: o });
  obs.start(obsSettings());
  return status();
});
ipcMain.handle('set-panel-password', (_e, password) => {
  password = String(password || '');
  if (password.length < 8) return { ok: false, error: 'use at least 8 characters' };
  if (password.length > 200) return { ok: false, error: 'that is too long' };
  writeConfig({ panelPassword: hashPassword(password) });
  server.logoutAll(); // everyone logs in again with the new one
  log('panel password changed: everyone has to log in again');
  return { ok: true };
});
ipcMain.handle('set-port', async (_e, port) => {
  port = Number(port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return { ok: false, error: 'pick a port between 1024 and 65535' };
  writeConfig({ port });
  await startServer();
  return { ok: server.port() === port, status: status() };
});
ipcMain.handle('autostart', (_e, on) => {
  app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
  return app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle('logout-all', () => { server.logoutAll(); log('logged everyone out of the panel'); return status(); });
ipcMain.handle('open', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});
