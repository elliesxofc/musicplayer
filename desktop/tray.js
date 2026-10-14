'use strict';

/* moonlit in the system tray (Windows: the hidden icons behind the ^ next to the clock),
   and a Windows notification when a new song starts.

   With "keep moonlit in the tray" on, closing or minimising the window hides it from the
   taskbar instead of quitting, and the music keeps playing. Clicking the tray icon brings
   it back; right-clicking gives play/pause, next, previous and quit. */

const { Tray, Menu, Notification, nativeImage, app } = require('electron');
const path = require('node:path');

function createTray({ root, getWindow, send, load, save, iconFile = () => path.join(root, 'icons', 'icon-192.png') }) {
  let settings = { tray: false, notify: true, notifyAlways: false, ...load() };
  let tray = null, song = null, playing = false, quitting = false, toldAboutTray = false;

  const icon = () => {
    const img = nativeImage.createFromPath(iconFile()); // follows the theme when that's on
    return img.isEmpty() ? img : img.resize({ width: 32, height: 32 });
  };

  function show() {
    const win = getWindow();
    if (!win) return;
    win.setSkipTaskbar(false);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  function hide() {
    const win = getWindow();
    if (!win) return;
    win.hide();
    win.setSkipTaskbar(true);
    // the first time, say where it went
    if (!toldAboutTray && Notification.isSupported()) {
      toldAboutTray = true;
      new Notification({ title: 'moonlit is still here ♡', body: 'the music keeps playing. click the moonlit icon by the clock (under ^) to open it again.', icon: icon(), silent: true }).show();
    }
  }

  function menu() {
    const label = song ? `${song.artist ? `${song.artist} - ` : ''}${song.title}` : 'nothing playing';
    return Menu.buildFromTemplate([
      { label: label.length > 60 ? `${label.slice(0, 57)}…` : label, enabled: false },
      { type: 'separator' },
      { label: playing ? 'pause' : 'play', click: () => send('tray:command', 'toggle') },
      { label: 'next song', click: () => send('tray:command', 'next') },
      { label: 'previous song', click: () => send('tray:command', 'prev') },
      { type: 'separator' },
      { label: 'open moonlit', click: show },
      { label: 'quit moonlit', click: () => { quitting = true; app.quit(); } },
    ]);
  }

  function refresh() {
    if (!tray) return;
    const now = song ? `${song.artist ? `${song.artist} - ` : ''}${song.title}` : '';
    tray.setToolTip(now ? `moonlit · ${now}`.slice(0, 127) : 'moonlit');
    tray.setContextMenu(menu());
  }

  function apply() {
    if (settings.tray && !tray) {
      tray = new Tray(icon());
      tray.on('click', () => { const win = getWindow(); if (win && win.isVisible() && !win.isMinimized()) hide(); else show(); });
      tray.on('double-click', show);
      refresh();
    } else if (!settings.tray && tray) {
      tray.destroy();
      tray = null;
      show(); // never leave the window hidden with no way back
    }
  }

  // the window's close and minimise buttons hide it to the tray (when that's on)
  function attach(win) {
    win.on('close', e => {
      if (settings.tray && !quitting) { e.preventDefault(); hide(); }
    });
    win.on('minimize', e => {
      if (settings.tray) { e.preventDefault(); hide(); }
    });
  }
  app.on('before-quit', () => { quitting = true; });

  // a new song started: update the tray, and maybe show a Windows notification
  function nowPlaying(next) {
    const fresh = next && (!song || song.id !== next.id);
    song = next ? { id: next.id, title: String(next.title || ''), artist: String(next.artist || '') } : null;
    refresh();
    if (!fresh || !settings.notify || !Notification.isSupported()) return;
    const win = getWindow();
    const looking = win && win.isVisible() && win.isFocused() && !win.isMinimized();
    if (looking && !settings.notifyAlways) return; // you can already see it
    let img = null;
    if (next.cover) { try { img = nativeImage.createFromBuffer(Buffer.from(next.cover)); } catch { img = null; } }
    const n = new Notification({
      title: song.title || 'now playing',
      body: [song.artist, next.album].filter(Boolean).join(' · ') || 'moonlit',
      icon: img && !img.isEmpty() ? img.resize({ width: 256, height: 256, quality: 'good' }) : icon(),
      silent: true, // never a ding on stream
    });
    n.on('click', show);
    n.show();
  }

  // the theme (and with it the icon) changed
  function refreshIcon() { if (tray) tray.setImage(icon()); }

  function setPlaying(on) { if (playing !== !!on) { playing = !!on; refresh(); } }

  function set(patch) {
    settings = { ...settings, ...patch };
    save(settings);
    apply();
    return settings;
  }

  app.whenReady().then(apply);
  // a quit that was called off ("keep it open" in the close popup)
  const cancelQuit = () => { quitting = false; };
  return { attach, show, nowPlaying, setPlaying, set, refreshIcon, get: () => settings, quitting: () => quitting, cancelQuit };
}

module.exports = { createTray };
