namespace PrintBroker.Infrastructure;

internal sealed class PrinterStatusSnapshot
{
    public bool IsOffline { get; init; }
    public bool IsPaperOut { get; init; }
    public bool IsJam { get; init; }
    public string StateText { get; init; } = "Unknown";
}
