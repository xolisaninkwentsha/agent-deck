// The only bridge between the panel's page and the app. Nothing else from Node is exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deck', {
  config: () => ipcRenderer.invoke('config'),
  onConfigChanged: (fn) => ipcRenderer.on('config-changed', (_e, cfg) => fn(cfg)),
  onApprovals: (fn) => ipcRenderer.on('approvals', (_e, enabled) => fn(enabled)), // changed from the tray
  resize: (height) => ipcRenderer.send('resize', height),
  setApprovals: (enabled) => ipcRenderer.send('set-approvals', enabled),
  notify: (title, body, target) => ipcRenderer.send('notify', { title, body, target }),
  onJump: (fn) => ipcRenderer.on('jump', (_e, target) => fn(target)), // a notification was clicked
  quit: () => ipcRenderer.send('quit'),
  minimize: () => ipcRenderer.send('minimize'),
});
