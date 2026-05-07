class PrintService {
  constructor() {
    this.printerName = null;
  }

  configurePrinter(printerName) {
    this.printerName = printerName;
  }

  async enqueuePrintJob(_payload) {
    return { accepted: true };
  }
}

module.exports = { PrintService };
