namespace PrintBroker.Domain;

public sealed class PrintJobStatusEvent
{
    public required Guid JobId { get; init; }
    public required PrintJobStatus Status { get; init; }
    public required DateTimeOffset TimestampUtc { get; init; }
    public string? Message { get; init; }
}
