const { contextBridge, ipcRenderer } = require('electron');
const { Channels } = require('./ipc/channels');

contextBridge.exposeInMainWorld('mirrorApi', {
  getSyncOverview: () => ipcRenderer.invoke(Channels.APP_GET_SYNC_OVERVIEW),
  getSettings: () => ipcRenderer.invoke(Channels.APP_GET_SETTINGS),
  updateSettings: (payload) => ipcRenderer.invoke(Channels.APP_UPDATE_SETTINGS, payload)
});
