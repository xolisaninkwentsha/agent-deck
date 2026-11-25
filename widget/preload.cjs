// The only bridge between the panel's page and the app. Nothing else from Node is exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deck', {
  config: () => ipcRenderer.invoke('config'),
  onConfigChanged: (fn) => ipcRenderer.on('config-changed', (_e, cfg) => fn(cfg)),
  onApprovals: (fn) => ipcRenderer.on('approvals', (_e, enabled) => fn(enabled)), // changed from the tray
  resize: (height) => ipcRenderer.send('resize', height),
  setApprovals: (enabled) => ipcRenderer.send('set-approvals', enabled),
  saveSettings: (patch) => ipcRenderer.send('save-settings', patch),
  openLink: (url) => ipcRenderer.send('open-link', url), // main only opens http(s) links
  addHub: (name, address, token) => ipcRenderer.invoke('add-hub', { name, address, token }), // validated in main
  removeHub: (name) => ipcRenderer.send('remove-hub', name),
  copyShareLine: () => ipcRenderer.send('copy-share-line'),
  share: (on) => ipcRenderer.invoke('share', Boolean(on)), // restarts the daemon; resolves { ok, error }
  tailscaleDevices: () => ipcRenderer.invoke('tailscale-devices'),
  pair: (ip) => ipcRenderer.invoke('pair', String(ip)), // resolves when the other machine answers
  notify: (title, body, target) => ipcRenderer.send('notify', { title, body, target }),
  onJump: (fn) => ipcRenderer.on('jump', (_e, target) => fn(target)), // a notification was clicked
  quit: () => ipcRenderer.send('quit'),
  minimize: () => ipcRenderer.send('minimize'),
});
