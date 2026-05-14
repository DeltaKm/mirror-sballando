using System.Management;

namespace PrintBroker.Infrastructure;

internal sealed class WmiPrinterDiagnostics : IPrinterDiagnostics
{
    public Task<PrinterStatusSnapshot> GetStatusAsync(string printerName, CancellationToken cancellationToken)
    {
        return Task.Run(() =>
        {
            cancellationToken.ThrowIfCancellationRequested();

            var escaped = printerName.Replace("\\", "\\\\").Replace("'", "\\'");
            var query = $"SELECT Name, PrinterStatus, WorkOffline, DetectedErrorState, ExtendedPrinterStatus FROM Win32_Printer WHERE Name = '{escaped}'";

            using var searcher = new ManagementObjectSearcher(query);
            using var collection = searcher.Get();
            var item = collection.Cast<ManagementObject>().FirstOrDefault();

            if (item is null)
            {
                return new PrinterStatusSnapshot
                {
                    IsOffline = true,
                    StateText = "PrinterNotFound"
                };
            }

            var offline = ToBool(item["WorkOffline"]);
            var detectedError = ToInt(item["DetectedErrorState"]);
            var status = ToInt(item["PrinterStatus"]);

            return new PrinterStatusSnapshot
            {
                IsOffline = offline || status == 7,
                IsPaperOut = detectedError is 3 or 4,
                IsJam = detectedError == 8,
                StateText = $"PrinterStatus={status};DetectedErrorState={detectedError};Offline={offline}"
            };
        }, cancellationToken);
    }

    private static bool ToBool(object? value)
    {
        return value is not null && Convert.ToBoolean(value);
    }

    private static int ToInt(object? value)
    {
        return value is null ? 0 : Convert.ToInt32(value);
    }
}
