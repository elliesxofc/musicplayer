'use strict';

// the hidden screen-sharing window and the program
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('capture', {
  onStart: cb => ipcRenderer.on('start', (_e, job) => cb(job)),
  onStop: cb => ipcRenderer.on('stop', (_e, why) => cb(String(why || ''))),
  onLimit: cb => ipcRenderer.on('limit', (_e, l) => cb(l)),
  answer: (id, result) => ipcRenderer.send('answer', id, result),
  input: msg => ipcRenderer.send('input', msg),
  ended: why => ipcRenderer.send('ended', String(why || '')),
});
