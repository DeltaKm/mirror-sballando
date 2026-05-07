namespace PrintBroker.Domain;

public sealed class CreatePrintJobRequest
{
    public string ImagePath { get; set; } = string.Empty;
    public string PrinterName { get; set; } = string.Empty;
    public int Copies { get; set; } = 1;
    public PrintPaperSize PaperSize { get; set; } = PrintPaperSize.Paper10x15;
    public PrintOrientation Orientation { get; set; } = PrintOrientation.Portrait;
    public Dictionary<string, string>? Metadata { get; set; }
}
