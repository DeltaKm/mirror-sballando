using System.Diagnostics;
using System.Drawing;
using System.Drawing.Printing;
using System.Management;
using Microsoft.Extensions.Logging;
using PrintBroker.Domain;

namespace PrintBroker.Infrastructure;

internal sealed class WindowsPrinterService(ILogger<WindowsPrinterService> logger, IPrinterDiagnostics diagnostics) : IPrinterService
{
    private const double MmPerInch = 25.4;

    public async Task<IReadOnlyList<PrinterInfo>> GetPrintersAsync(CancellationToken cancellationToken)
    {
        var queryTask = Task.Run(() =>
        {
            var defaultPrinter = new PrinterSettings().PrinterName;
            var list = new List<PrinterInfo>();
            using var searcher = new ManagementObjectSearcher("SELECT Name, Default FROM Win32_Printer");
            using var collection = searcher.Get();

            foreach (var item in collection.Cast<ManagementObject>())
            {
                cancellationToken.ThrowIfCancellationRequested();
                var name = item["Name"]?.ToString() ?? string.Empty;
                if (string.IsNullOrWhiteSpace(name))
                {
                    continue;
                }

                var settings = new PrinterSettings { PrinterName = name };
                list.Add(new PrinterInfo
                {
                    Name = name,
                    IsDefault = string.Equals(name, defaultPrinter, StringComparison.OrdinalIgnoreCase) || Convert.ToBoolean(item["Default"] ?? false),
                    IsValid = settings.IsValid,
                    StateText = "StatusUnavailable"
                });
            }

            return (IReadOnlyList<PrinterInfo>)list;
        }, cancellationToken);

        var completed = await Task.WhenAny(queryTask, Task.Delay(TimeSpan.FromSeconds(5), cancellationToken));
        if (completed != queryTask)
        {
            logger.LogWarning("Timeout while querying printers list");
            return Array.Empty<PrinterInfo>();
        }

        return await queryTask;
    }

    public async Task PrintAsync(PrintJob job, TimeSpan printTimeout, CancellationToken cancellationToken)
    {
        var status = await diagnostics.GetStatusAsync(job.PrinterName, cancellationToken);
        if (status.IsOffline)
        {
            throw new InvalidOperationException($"PrinterOffline:{status.StateText}");
        }

        if (status.IsPaperOut)
        {
            throw new InvalidOperationException($"PrinterPaperOut:{status.StateText}");
        }

        if (status.IsJam)
        {
            throw new InvalidOperationException($"PrinterJam:{status.StateText}");
        }

        if (!File.Exists(job.ImagePath))
        {
            throw new FileNotFoundException("Image not found", job.ImagePath);
        }

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(printTimeout);

        var printTask = Task.Run(() => ExecutePrint(job), timeoutCts.Token);
        var completed = await Task.WhenAny(printTask, Task.Delay(Timeout.InfiniteTimeSpan, timeoutCts.Token));
        if (completed != printTask)
        {
            throw new TimeoutException($"Print timeout after {printTimeout}");
        }

        await printTask;
    }

    private void ExecutePrint(PrintJob job)
    {
        using var image = Image.FromFile(job.ImagePath);
        using var doc = new PrintDocument();
        doc.PrinterSettings.PrinterName = job.PrinterName;
        doc.PrinterSettings.Copies = (short)Math.Max(1, job.Copies);

        if (!doc.PrinterSettings.IsValid)
        {
            throw new InvalidOperationException($"InvalidPrinter:{job.PrinterName}");
        }

        doc.DefaultPageSettings.Landscape = job.Orientation == PrintOrientation.Landscape;
        ApplyPaperSize(doc, job.PaperSize);

        doc.PrintPage += (_, args) =>
        {
            if (args.Graphics is null)
            {
                throw new InvalidOperationException("Printer graphics context unavailable");
            }

            var bounds = args.PageBounds;
            var target = ComputeTargetRect(image.Width, image.Height, bounds.Width, bounds.Height);
            args.Graphics.DrawImage(image, target);
            args.HasMorePages = false;
        };

        var sw = Stopwatch.StartNew();
        doc.Print();
        sw.Stop();
        logger.LogInformation("Printed job {JobId} in {ElapsedMs}ms", job.Id, sw.ElapsedMilliseconds);
    }

    private static void ApplyPaperSize(PrintDocument doc, PrintPaperSize size)
    {
        if (size != PrintPaperSize.Paper10x15)
        {
            return;
        }

        var widthInHundredths = MmToHundredths(100);
        var heightInHundredths = MmToHundredths(150);

        var custom = new PaperSize("Photo10x15", widthInHundredths, heightInHundredths);
        doc.DefaultPageSettings.PaperSize = custom;
    }

    private static int MmToHundredths(int mm)
    {
        return (int)Math.Round(mm / MmPerInch * 100.0, MidpointRounding.AwayFromZero);
    }

    private static Rectangle ComputeTargetRect(int imageWidth, int imageHeight, int pageWidth, int pageHeight)
    {
        var imageRatio = imageWidth / (double)imageHeight;
        var pageRatio = pageWidth / (double)pageHeight;

        if (imageRatio > pageRatio)
        {
            var targetHeight = (int)Math.Round(pageWidth / imageRatio);
            var top = (pageHeight - targetHeight) / 2;
            return new Rectangle(0, top, pageWidth, targetHeight);
        }

        var targetWidth = (int)Math.Round(pageHeight * imageRatio);
        var left = (pageWidth - targetWidth) / 2;
        return new Rectangle(left, 0, targetWidth, pageHeight);
    }
}
