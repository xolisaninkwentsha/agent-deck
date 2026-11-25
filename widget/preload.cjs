// The only bridge between the panel's page and the app. Nothing else from Node is exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deck', {
  config: () => ipcRenderer.invoke('config'),
  onConfigChanged: (fn) => ipcRenderer.on('config-changed', (_e, cfg) => fn(cfg)),
  resize: (height) => ipcRenderer.send('resize', height),
  setApprovals: (enabled) => ipcRenderer.send('set-approvals', enabled),
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
  quit: () => ipcRenderer.send('quit'),
  minimize: () => ipcRenderer.send('minimize'),
});
