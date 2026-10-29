'use strict';

/* Stagelight: a remote control for OBS in any browser.
   Runs on the stream PC (in the tray, by the clock), talks to OBS there, and serves a
   password-protected panel to phones, tablets and other PCs on the same network, or from
   anywhere through Tailscale. */

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { createObs } = require('./obs');
const { createServer, hashPassword, ROLES } = require('./server');
const { createRemote } = require('./remote');

// the remote display's video goes straight between the PCs: real addresses (not hidden ones)
// so a phone on the same network or Tailscale finds this PC
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

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

const winOpen = () => !!(win && !win.isDestroyed() && win.isVisible());
const obs = createObs({ onChange: () => { remote.streamChanged(obs.snapshot().stream); server.broadcast(); if (winOpen()) sendWin('status', status()); refreshTray(); }, log });
// OBS is asked often only while someone looks (a panel, or the settings window)
const updateBusy = () => obs.setBusy(server.watcherCount() > 0 || winOpen() || remote.status().active);
const UPLOAD_LIMITS = [0, 4_000_000, 2_000_000, 1_000_000, 500_000]; // 0 = no limit
const remoteSettings = () => {
  const r = readConfig().remote || {};
  return { view: !!r.view, control: !!r.view && !!r.control, max: UPLOAD_LIMITS.includes(r.max) ? r.max : 0 };
};
const remote = createRemote({
  root: ROOT, icon: ICON, getSettings: remoteSettings, log,
  onChange: () => { updateBusy(); sendWin('status', status()); refreshTray(); },
});
remote.settings = remoteSettings;
remote.info = () => { const r = remote.status(); return { ...remoteSettings(), controlWorks: remote.canControl(), active: r.active, from: r.from }; };
/* ───────────── accounts: who can open the panel, and what they can do ───────────── */
function accounts() {
  const c = readConfig();
  // before accounts there was one shared panel password: it becomes the account "stagelight"
  if (!c.accounts && c.panelPassword) {
    const moved = [{ name: 'stagelight', role: 'full', ...c.panelPassword, stamp: crypto.randomUUID() }];
    writeConfig({ accounts: moved, panelPassword: undefined });
    return moved;
  }
  return Array.isArray(c.accounts) ? c.accounts : [];
}
// your own web address through a Cloudflare Tunnel: off unless switched on here
const webSettings = () => { const w = readConfig().web || {}; return { on: !!w.on, host: typeof w.host === 'string' ? w.host : '' }; };
const server = createServer({ obs, remote, getAccounts: accounts, getWeb: webSettings, log, onWatchers: updateBusy });

/* The stream comes first: every Stagelight process (window, screen sharing, the GPU helper)
   runs below normal priority, so when the PC is busy Windows serves OBS before Stagelight. */
function lowerPriority() {
  const below = os.constants.priority.PRIORITY_BELOW_NORMAL;
  for (const m of app.getAppMetrics()) { try { os.setPriority(m.pid, below); } catch { /* gone, or not allowed */ } }
}

function status() {
  const s = obs.snapshot();
  return { obs: s.status, connected: s.connected, live: s.stream.active, recording: s.record.active, sessions: server.sessionCount(), port: server.port(), addresses: addresses(), remote: remote.status(), web: { ...webSettings(), lastVisit: server.lastWebVisit() } };
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
  // closing the window keeps Stagelight running in the tray (the panel keeps working); the window
  // itself is really closed, so it takes no memory until it's opened again
  win.on('show', updateBusy);
  win.on('hide', updateBusy);
  win.on('closed', () => { win = null; updateBusy(); });
  win.webContents.on('did-finish-load', () => setTimeout(lowerPriority, 500));
}

let trayWas = '';
function refreshTray(force = false) {
  if (!tray) return;
  const what = obs.summary();
  const key = `${what}|${remote.status().active}|${remote.status().from}`;
  if (key === trayWas && !force) return; // nothing new to show: leave the tray menu alone
  trayWas = key;
  tray.setToolTip(`Stagelight · ${what}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Stagelight · ${what}`, enabled: false },
    { type: 'separator' },
    ...(remote.status().active ? [{ label: `stop the remote display (${remote.status().from})`, click: () => remote.end('stopped on the stream PC') }] : []),
    { label: 'open the panel here', click: () => shell.openExternal(`http://localhost:${server.port() || panelPort()}`) },
    { label: 'settings', click: showWindow },
    { type: 'separator' },
    { label: 'quit Stagelight', click: () => { quitting = true; app.quit(); } },
  ]));
}

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; remote.stop(); obs.stop(); server.stop(); });
app.on('window-all-closed', () => { /* stays in the tray */ });

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 32, height: 32 }));
  tray.on('click', showWindow);
  refreshTray();
  showWindow();
  await startServer();
  lowerPriority();
  setInterval(lowerPriority, 30_000).unref(); // new helpers (screen sharing) get it too
  if (readConfig().obs) obs.start(obsSettings());
  else log('add OBS\'s WebSocket details to connect');
});

/* ───────────── the settings window asks ───────────── */
ipcMain.handle('get', () => {
  const c = readConfig();
  const o = obsSettings();
  return {
    obs: { host: o.host, port: o.port, hasPassword: !!o.password },
    accounts: accounts().map(a => ({ name: a.name, role: a.role })),
    port: panelPort(),
    autostart: app.getLoginItemSettings().openAtLogin,
    remote: { ...remoteSettings(), controlWorks: remote.canControl() },
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
ipcMain.handle('accounts', () => accounts().map(a => ({ name: a.name, role: a.role })));
// add an account, or change one's password or access (a new password logs that account out)
ipcMain.handle('save-account', (_e, next) => {
  const name = String((next && next.name) || '').trim();
  const role = ROLES.includes(next && next.role) ? next.role : 'control';
  const password = typeof (next && next.password) === 'string' ? next.password : '';
  if (!/^[\w.@-]{2,32}$/.test(name)) return { ok: false, error: 'a username is 2 to 32 letters, numbers, dots, dashes or underscores (no spaces)' };
  const list = accounts();
  const old = list.find(a => a.name.toLowerCase() === name.toLowerCase());
  if (!old && !password) return { ok: false, error: 'a new account needs a password' };
  if (password && password.length < 10) return { ok: false, error: 'use at least 10 characters for the password' };
  if (password.length > 200) return { ok: false, error: 'that password is too long' };
  const account = { name: old ? old.name : name, role, ...(password ? hashPassword(password) : { salt: old.salt, hash: old.hash }), stamp: crypto.randomUUID() };
  writeConfig({ accounts: old ? list.map(a => (a === old ? account : a)) : [...list, account] });
  server.logoutUser(account.name);
  log(old ? `account ${account.name} changed (${role})` : `account ${account.name} added (${role})`);
  return { ok: true, accounts: accounts().map(a => ({ name: a.name, role: a.role })) };
});
ipcMain.handle('remove-account', (_e, name) => {
  const list = accounts().filter(a => a.name.toLowerCase() !== String(name).toLowerCase());
  writeConfig({ accounts: list });
  server.logoutUser(String(name));
  log(`account ${name} removed`);
  return list.map(a => ({ name: a.name, role: a.role }));
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
// the remote display: watching, and mouse and keyboard (both off unless switched on here)
ipcMain.handle('set-remote', (_e, next) => {
  const view = !!(next && next.view), control = view && !!(next && next.control);
  writeConfig({ remote: { ...(readConfig().remote || {}), view, control } });
  remote.settingsChanged();
  log(`remote display ${view ? (control ? 'on, with mouse and keyboard' : 'on, watching only') : 'off'}`);
  return remoteSettings();
});
// "stage.lilianax.lol", "https://stage.lilianax.lol/" → stage.lilianax.lol
ipcMain.handle('set-web', (_e, next) => {
  const on = !!(next && next.on);
  let host = String((next && next.host) || '').trim().toLowerCase();
  try { if (host) host = new URL(/^[a-z]+:\/\//.test(host) ? host : `https://${host}`).hostname; } catch { host = ''; }
  if (on && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return { ok: false, error: 'type the web address, like stage.lilianax.lol' };
  writeConfig({ web: { on, host } });
  log(on ? `web address on: https://${host}` : 'web address off');
  return { ok: true, status: status() };
});
ipcMain.handle('set-remote-max', (_e, max) => {
  const m = UPLOAD_LIMITS.includes(Number(max)) ? Number(max) : 0;
  writeConfig({ remote: { ...(readConfig().remote || {}), max: m } });
  remote.settingsChanged();
  log(`remote display upload: ${m ? `at most ${m / 1_000_000} Mbps` : 'no limit'}`);
  return remoteSettings();
});
ipcMain.handle('remote-stop', () => { remote.end('stopped on the stream PC'); return status(); });
ipcMain.handle('logout-all', () => { server.logoutAll(); log('logged everyone out of the panel'); return status(); });
ipcMain.handle('open', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});
