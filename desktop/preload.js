'use strict';

// The small, fixed set of desktop-only abilities the player page is allowed to use.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('moonlitDesktop', {
  chooseNowPlayingFile: () => ipcRenderer.invoke('obs:choose'),
  getNowPlayingFile: () => ipcRenderer.invoke('obs:get'),
  unlinkNowPlaying: () => ipcRenderer.invoke('obs:unlink'),
  writeNowPlaying: text => ipcRenderer.invoke('obs:write', String(text)),
  getOpenAtLogin: () => ipcRenderer.invoke('startup:get'),
  setOpenAtLogin: on => ipcRenderer.invoke('startup:set', !!on),
  version: () => ipcRenderer.invoke('app:version'),
  // closing moonlit: the page shows "Do you want to close the program?" and answers
  onCloseRequest: callback => ipcRenderer.on('app:close-request', () => { ipcRenderer.send('app:close-seen'); callback(); }),
  answerClose: yes => ipcRenderer.send('app:close-answer', !!yes),
  // the window was hidden / minimised (false) or shown again (true)
  onVisible: callback => ipcRenderer.on('app:visible', (_e, on) => callback(!!on)),
  // songs opened from Windows (double-click / Open with)
  takePendingFiles: () => ipcRenderer.invoke('files:pending'),
  readFile: file => ipcRenderer.invoke('files:read', String(file)),
  // the window, taskbar and tray icon in a theme's colours (null: the usual icon)
  setIcon: theme => ipcRenderer.invoke('app:icon', theme == null ? null : String(theme)),
  // playlist files: import (a file picker) and export (a save dialog)
  playlist: {
    open: () => ipcRenderer.invoke('playlist:open'),
    save: (name, text) => ipcRenderer.invoke('playlist:save', String(name), String(text)),
  },
  onOpenFiles: callback => ipcRenderer.on('files:open', (_e, files) => callback(files)),
  // the tray icon (hide moonlit from the taskbar) and "now playing" notifications
  tray: {
    get: () => ipcRenderer.invoke('tray:get'),
    set: patch => ipcRenderer.invoke('tray:set', patch),
    nowPlaying: song => ipcRenderer.send('tray:now-playing', song),
    playing: on => ipcRenderer.send('tray:playing', !!on),
    onCommand: cb => ipcRenderer.on('tray:command', (_e, cmd) => cb(String(cmd))),
  },
  // now-playing overlay for OBS
  overlay: {
    state: s => ipcRenderer.send('overlay:state', s),
    cover: (id, type, bytes) => ipcRenderer.send('overlay:cover', id, type, bytes),
    url: () => ipcRenderer.invoke('overlay:url'),
    open: url => ipcRenderer.invoke('overlay:open', String(url)),
    spectrum: levels => ipcRenderer.send('overlay:spectrum', levels),
    // how many overlays are open (in OBS or a browser), so the bars are only sampled when seen
    onWatchers: cb => ipcRenderer.on('overlay:watchers', (_e, n) => cb(n)),
  },
  // !nowplaying in YouTube chat
  chat: {
    get: () => ipcRenderer.invoke('chat:get'),
    set: settings => ipcRenderer.invoke('chat:set', settings),
    preview: () => ipcRenderer.invoke('chat:preview'),
    // when the live stream the bot is in started on YouTube (ms, 0 if unknown), for !uptime
    liveStart: () => ipcRenderer.invoke('chat:live-start'),
    onStatus: cb => ipcRenderer.on('chat:status', (_e, s) => cb(s)),
    // song requests: commands from chat, and the player's answers
    onCommand: cb => ipcRenderer.on('chat:command', (_e, c) => cb(c)),
    say: text => ipcRenderer.send('chat:say', String(text)),
    // the request channel list: a channel link, @handle or video link → { ok, id, name }
    resolveChannel: input => ipcRenderer.invoke('channels:resolve', String(input)),
  },
  // Spotify's now playing
  spotify: {
    get: () => ipcRenderer.invoke('spotify:get'),
    connect: clientId => ipcRenderer.invoke('spotify:connect', String(clientId)),
    control: action => ipcRenderer.invoke('spotify:control', String(action)),
    disconnect: () => ipcRenderer.invoke('spotify:disconnect'),
    setLocal: on => ipcRenderer.invoke('spotify:local', !!on),
    onLocalStatus: cb => ipcRenderer.on('spotify:local-status', (_e, s) => cb(s)),
    open: url => ipcRenderer.invoke('spotify:open', String(url)),
    onState: cb => ipcRenderer.on('spotify:state', (_e, s) => cb(s)),
    onStatus: cb => ipcRenderer.on('spotify:status', (_e, s) => cb(s)),
  },
  // downloader
  download: {
    add: (url, format) => ipcRenderer.invoke('dl:add', String(url), String(format)),
    // a whole playlist saved as a .csv file (e.g. from exportify.net)
    addList: (text, format) => ipcRenderer.invoke('dl:add-list', String(text), String(format)),
    list: () => ipcRenderer.invoke('dl:list'),
    cancel: id => ipcRenderer.invoke('dl:cancel', id),
    retry: id => ipcRenderer.invoke('dl:retry', id),
    cancelAll: () => ipcRenderer.invoke('dl:cancel-all'),
    clearFinished: () => ipcRenderer.invoke('dl:clear'),
    folder: () => ipcRenderer.invoke('dl:folder'),
    chooseFolder: () => ipcRenderer.invoke('dl:choose-folder'),
    openFolder: () => ipcRenderer.invoke('dl:open-folder'),
    // a song request from chat: find it on YouTube (within the rules), download once, give back the file
    request: (query, rules) => ipcRenderer.invoke('dl:request', String(query), rules),
    forgetRequest: file => ipcRenderer.invoke('dl:forget-request', String(file)),
    requestFiles: () => ipcRenderer.invoke('dl:request-files'),
    onUpdate: cb => ipcRenderer.on('dl:update', (_e, job) => cb(job)),
    onRemove: cb => ipcRenderer.on('dl:remove', (_e, id) => cb(id)),
    onStatus: cb => ipcRenderer.on('dl:status', (_e, text) => cb(text)),
  },
});
