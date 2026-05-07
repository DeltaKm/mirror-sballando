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
  pingWindowControls: () => true
});