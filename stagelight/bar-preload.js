'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bar', {
  stop: () => ipcRenderer.send('bar-stop'),
  onText: cb => ipcRenderer.on('text', (_e, t) => cb(String(t))),
});
