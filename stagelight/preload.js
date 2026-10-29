'use strict';

// what Stagelight's settings window may ask the program for
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stagelight', {
  get: () => ipcRenderer.invoke('get'),
  setObs: settings => ipcRenderer.invoke('set-obs', settings),
  accounts: () => ipcRenderer.invoke('accounts'),
  saveAccount: account => ipcRenderer.invoke('save-account', account),
  removeAccount: name => ipcRenderer.invoke('remove-account', String(name)),
  setPort: port => ipcRenderer.invoke('set-port', Number(port)),
  autostart: on => ipcRenderer.invoke('autostart', !!on),
  logoutAll: () => ipcRenderer.invoke('logout-all'),
  setRemote: settings => ipcRenderer.invoke('set-remote', settings),
  setRemoteMax: max => ipcRenderer.invoke('set-remote-max', Number(max)),
  setRemoteFiles: on => ipcRenderer.invoke('set-remote-files', !!on),
  stopRemote: () => ipcRenderer.invoke('remote-stop'),
  setWeb: settings => ipcRenderer.invoke('set-web', settings),
  open: url => ipcRenderer.invoke('open', String(url)),
  openMedia: () => ipcRenderer.invoke('open-media'),
  onStatus: cb => ipcRenderer.on('status', (_e, s) => cb(s)),
  onLog: cb => ipcRenderer.on('log', (_e, line) => cb(line)),
});
