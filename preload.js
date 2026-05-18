const { contextBridge, ipcRenderer } = require('electron');

window.addEventListener('message', async (event) => {
  const payload = event && event.data;
  if (!payload || payload.source !== 'ms-window-controls') {
    return;
  }

  try {
    if (payload.action === 'minimize') {
      await ipcRenderer.invoke('window-minimize');
    }

    if (payload.action === 'toggle-fullscreen') {
      await ipcRenderer.invoke('window-toggle-fullscreen');
    }
  } catch {
    // Ignore bridge errors from remote page scripts.
  }
});

contextBridge.exposeInMainWorld('electronAPI', {
  deletePhoto: (filename) => ipcRenderer.invoke('delete-photo', filename),
  uploadPhoto: (filename) => ipcRenderer.invoke('upload-photo', filename),
  printImage: (filename, printerName, options) => ipcRenderer.invoke('print-image', filename, printerName, options),
  getPrinters: () => ipcRenderer.invoke('get-printers'),
  getPrintJob: (jobId) => ipcRenderer.invoke('get-print-job', jobId),
  cancelPrintJob: (jobId) => ipcRenderer.invoke('cancel-print-job', jobId),
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  toggleWindowFullscreen: () => ipcRenderer.invoke('window-toggle-fullscreen'),
  isWindowFullscreen: () => ipcRenderer.invoke('window-is-fullscreen'),
  onWindowFullscreenChanged: (callback) => {
    if (typeof callback !== 'function') {
      return () => {};
    }
    const handler = (_event, isFullscreen) => {
      try { callback(!!isFullscreen); } catch (_) {}
    };
    ipcRenderer.on('window-fullscreen-changed', handler);
    return () => ipcRenderer.removeListener('window-fullscreen-changed', handler);
  },
  getSaveFolder: () => ipcRenderer.invoke('get-save-folder'),
  setCurrentEventFolder: (eventName) => ipcRenderer.invoke('set-current-event-folder', eventName),
  getEventPhotos: (eventName) => ipcRenderer.invoke('get-event-photos', eventName),
  resolveOriginalPhotoPath: (eventName, photoId) => ipcRenderer.invoke('resolve-original-photo-path', eventName, photoId),
  saveCapturedPhoto: (payload) => ipcRenderer.invoke('save-captured-photo', payload),
  setSaveFolder: (p) => ipcRenderer.invoke('set-save-folder', p),
  chooseSaveFolder: () => ipcRenderer.invoke('choose-save-folder'),
  chooseFrameFile: () => ipcRenderer.invoke('choose-frame-file'),
  pingWindowControls: () => true,
  setSessionMode: (active) => ipcRenderer.invoke('set-session-mode', active),
  navigateHome: () => ipcRenderer.invoke('navigate-home'),
  listSystemPrinters: () => ipcRenderer.invoke('list-system-printers'),
  getPrinterState: (force) => ipcRenderer.invoke('get-printer-state', !!force),
  setSelectedPrinter: (name) => ipcRenderer.invoke('set-selected-printer', name),
  getSelectedPrinter: () => ipcRenderer.invoke('get-selected-printer'),
  getPrintCalibration: () => ipcRenderer.invoke('get-print-calibration'),
  setPrintCalibration: (cal) => ipcRenderer.invoke('set-print-calibration', cal),
  printTestPattern: (payload) => ipcRenderer.invoke('print-test-pattern', payload || {}),
  onPrinterState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, state) => {
      try { callback(state || null); } catch (_) {}
    };
    ipcRenderer.on('printer-state', handler);
    return () => ipcRenderer.removeListener('printer-state', handler);
  },
});