namespace PrintBroker.Domain;

public sealed class PrintJob
{
    public Guid Id { get; set; }
    public string ImagePath { get; set; } = string.Empty;
    public string PrinterName { get; set; } = string.Empty;
    public int Copies { get; set; } = 1;
    public PrintPaperSize PaperSize { get; set; } = PrintPaperSize.Paper10x15;
    public PrintOrientation Orientation { get; set; } = PrintOrientation.Portrait;
    public string? MetadataJson { get; set; }
    public PrintJobStatus Status { get; set; } = PrintJobStatus.Queued;
    public int AttemptCount { get; set; }
    public int MaxRetries { get; set; }
    public DateTimeOffset CreatedAtUtc { get; set; }
    public DateTimeOffset UpdatedAtUtc { get; set; }
    public DateTimeOffset? StartedAtUtc { get; set; }
    public DateTimeOffset? CompletedAtUtc { get; set; }
    public string? LastError { get; set; }
    public bool CancelRequested { get; set; }
}
