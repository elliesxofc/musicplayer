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
  // songs opened from Windows (double-click / Open with)
  takePendingFiles: () => ipcRenderer.invoke('files:pending'),
  readFile: file => ipcRenderer.invoke('files:read', String(file)),
  onOpenFiles: callback => ipcRenderer.on('files:open', (_e, files) => callback(files)),
  // now-playing overlay for OBS
  overlay: {
    state: s => ipcRenderer.send('overlay:state', s),
    cover: (id, type, bytes) => ipcRenderer.send('overlay:cover', id, type, bytes),
    url: () => ipcRenderer.invoke('overlay:url'),
    open: url => ipcRenderer.invoke('overlay:open', String(url)),
  },
  // downloader
  download: {
    add: (url, format) => ipcRenderer.invoke('dl:add', String(url), String(format)),
    list: () => ipcRenderer.invoke('dl:list'),
    cancel: id => ipcRenderer.invoke('dl:cancel', id),
    retry: id => ipcRenderer.invoke('dl:retry', id),
    cancelAll: () => ipcRenderer.invoke('dl:cancel-all'),
    clearFinished: () => ipcRenderer.invoke('dl:clear'),
    folder: () => ipcRenderer.invoke('dl:folder'),
    chooseFolder: () => ipcRenderer.invoke('dl:choose-folder'),
    openFolder: () => ipcRenderer.invoke('dl:open-folder'),
    onUpdate: cb => ipcRenderer.on('dl:update', (_e, job) => cb(job)),
    onRemove: cb => ipcRenderer.on('dl:remove', (_e, id) => cb(id)),
    onStatus: cb => ipcRenderer.on('dl:status', (_e, text) => cb(text)),
  },
});
