'use strict';
// Ponte segura entre a interface e o processo principal.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['host:status', 'update:status', 'deeplink', 'backup:status']);

contextBridge.exposeInMainWorld('concordo', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  hostStart: (opts) => ipcRenderer.invoke('host:start', opts),
  hostStop: () => ipcRenderer.invoke('host:stop'),
  hostInfo: () => ipcRenderer.invoke('host:info'),
  hostRetryTunnel: () => ipcRenderer.invoke('host:retry-tunnel'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  download: (url) => ipcRenderer.invoke('app:download', url),
  takeDeepLink: () => ipcRenderer.invoke('app:take-deeplink'),
  getFixedAddress: () => ipcRenderer.invoke('tunnel:get-fixed'),
  setFixedAddress: (cfg) => ipcRenderer.invoke('tunnel:set-fixed', cfg),
  clearFixedAddress: () => ipcRenderer.invoke('tunnel:clear-fixed'),
  screenSources: () => ipcRenderer.invoke('screen:sources'),
  screenPrepare: (sel) => ipcRenderer.invoke('screen:prepare', sel),
  backupStart: (args) => ipcRenderer.invoke('backup:start', args),
  backupSyncNow: (roomId) => ipcRenderer.invoke('backup:sync-now', roomId),
  backupStop: (roomId) => ipcRenderer.invoke('backup:stop', roomId),
  backupStatus: (roomId) => ipcRenderer.invoke('backup:status', roomId),
  backupTakeover: (args) => ipcRenderer.invoke('backup:takeover', args),
  rendezvousResolve: (rv) => ipcRenderer.invoke('rendezvous:resolve', rv),
  showWindow: () => ipcRenderer.invoke('app:show-window'),
  getSettings: () => ipcRenderer.invoke('app:get-settings'),
  setSettings: (next) => ipcRenderer.invoke('app:set-settings', next),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  on(channel, callback) {
    if (!EVENTS.has(channel)) return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
