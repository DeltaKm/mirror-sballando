const { ipcMain } = require('electron');
const { Channels } = require('./channels');

function registerIpcHandlers(services) {
  ipcMain.handle(Channels.APP_GET_SYNC_OVERVIEW, async () => {
    return services.sync.getOverview();
  });

  ipcMain.handle(Channels.APP_GET_SETTINGS, async () => {
    return services.settings.getAll();
  });

  ipcMain.handle(Channels.APP_UPDATE_SETTINGS, async (_event, payload) => {
    return services.settings.update(payload || {});
  });
}

module.exports = { registerIpcHandlers };
