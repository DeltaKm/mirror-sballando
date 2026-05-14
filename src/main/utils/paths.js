const path = require('node:path');
const { app } = require('electron');

function getRuntimeRoot() {
  return app.isPackaged ? process.resourcesPath : process.cwd();
}

function getStorageRoot() {
  if (process.env.MIRROR_STORAGE_ROOT) {
    return process.env.MIRROR_STORAGE_ROOT;
  }
  return path.join(getRuntimeRoot(), 'storage');
}

function getDatabasePath() {
  if (process.env.MIRROR_DB_PATH) {
    return process.env.MIRROR_DB_PATH;
  }
  return path.join(getStorageRoot(), 'mirror.db');
}

module.exports = {
  getRuntimeRoot,
  getStorageRoot,
  getDatabasePath
};
