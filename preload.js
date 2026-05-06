const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  deletePhoto: (filename) => ipcRenderer.invoke('delete-photo', filename),
  uploadPhoto: (filename) => ipcRenderer.invoke('upload-photo', filename),
  printImage: (filename, printerName) => ipcRenderer.invoke('print-image', filename, printerName),
  getPrinters: () => ipcRenderer.invoke('get-printers')
});