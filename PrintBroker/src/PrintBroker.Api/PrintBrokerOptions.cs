namespace PrintBroker.Api;

public sealed class PrintBrokerOptions
{
    public const string SectionName = "PrintBroker";

    public string BaseDataDirectory { get; set; } = string.Empty;
    public string DatabaseFileName { get; set; } = "printbroker.db";
    public int MaxRetries { get; set; } = 3;
    public int WorkerPollSeconds { get; set; } = 1;
    public int PrintTimeoutSeconds { get; set; } = 45;
    public int RetryBackoffSeconds { get; set; } = 5;
    public string ListenUrl { get; set; } = "http://127.0.0.1:5177";
}
