namespace PrintBroker.Infrastructure;

internal interface IPrinterDiagnostics
{
    Task<PrinterStatusSnapshot> GetStatusAsync(string printerName, CancellationToken cancellationToken);
}
