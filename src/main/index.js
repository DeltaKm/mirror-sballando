const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { DatabaseService } = require('./database/DatabaseService');
const { registerIpcHandlers } = require('./ipc/registerIpcHandlers');
const {
  CameraService,
  EventService,
  PrintService,
  StorageService,
  UploadService,
  SettingsService,
  SyncService
} = require('./services');
const logger = require('./utils/logger');
const { getDatabasePath, getStorageRoot } = require('./utils/paths');

let mainWindow;

function createServices() {
  const storage = new StorageService(getStorageRoot());
  storage.init();

  const database = new DatabaseService(getDatabasePath());
  database.init();

  const settings = new SettingsService();
  const sync = new SyncService(database);
  const camera = new CameraService();
  const print = new PrintService();
  const upload = new UploadService();
  const event = new EventService(database);

  return { storage, database, settings, sync, camera, print, upload, event };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 1920,
    minWidth: 1200,
    minHeight: 1920,
    backgroundColor: '#0e0e10',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    const rendererFile = path.join(process.cwd(), 'dist/renderer/index.html');
    mainWindow.loadFile(rendererFile);
  }

  mainWindow.setAspectRatio(1200 / 1920);
}

app.whenReady().then(() => {
  const services = createServices();
  registerIpcHandlers(services);
  services.sync.start();

  logger.info('Mirror Sballando boot completed');
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  app.on('before-quit', () => {
    services.sync.stop();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
