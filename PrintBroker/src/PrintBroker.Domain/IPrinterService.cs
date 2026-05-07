namespace PrintBroker.Domain;

public interface IPrinterService
{
    Task<IReadOnlyList<PrinterInfo>> GetPrintersAsync(CancellationToken cancellationToken);
    Task PrintAsync(PrintJob job, TimeSpan printTimeout, CancellationToken cancellationToken);
}
