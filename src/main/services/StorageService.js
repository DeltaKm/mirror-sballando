const fs = require('node:fs');
const path = require('node:path');

class StorageService {
  constructor(storageRoot) {
    this.storageRoot = storageRoot;
    this.folders = ['photos', 'previews', 'prints', 'templates', 'logs', 'cache'];
  }

  init() {
    fs.mkdirSync(this.storageRoot, { recursive: true });
    this.folders.forEach((folder) => {
      fs.mkdirSync(path.join(this.storageRoot, folder), { recursive: true });
    });
  }

  resolvePhotoPath(filename) {
    return path.join(this.storageRoot, 'photos', filename);
  }
}

module.exports = { StorageService };
