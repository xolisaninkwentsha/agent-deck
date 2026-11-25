// The activity window's only bridge: main tells it which session to watch, and on which machine.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('activity', {
  onInit: (fn) => ipcRenderer.on('activity-init', (_e, params) => fn(params)), // { hubUrl, token, key, title }
});
