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
});
