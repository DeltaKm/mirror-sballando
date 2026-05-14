namespace PrintBroker.Domain;

public sealed class PrinterInfo
{
    public string Name { get; set; } = string.Empty;
    public bool IsDefault { get; set; }
    public bool IsValid { get; set; }
    public bool IsOffline { get; set; }
    public bool IsPaperOut { get; set; }
    public bool IsJam { get; set; }
    public string? StateText { get; set; }
}
