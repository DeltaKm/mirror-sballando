class SettingsService {
  constructor() {
    this.settings = {
      countdownSeconds: 3,
      printerName: null,
      activeEventId: null,
      soundEnabled: true
    };
  }

  getAll() {
    return { ...this.settings };
  }

  update(partial) {
    this.settings = { ...this.settings, ...partial };
    return this.getAll();
  }
}

module.exports = { SettingsService };
