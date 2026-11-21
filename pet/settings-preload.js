'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopButlerSettings', {
  close: () => ipcRenderer.send('pet:close-settings'),
  getState: () => ipcRenderer.invoke('pet:settings-state'),
  action: (name, value) => ipcRenderer.send('pet:settings-action', { name: String(name), value }),
  onState: (cb) => ipcRenderer.on('pet:settings-state', (_e, state) => cb(state)),
});
