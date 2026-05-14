namespace PrintBroker.Domain;

public interface IPrintJobRepository
{
    Task<PrintJob> EnqueueAsync(CreatePrintJobRequest request, int maxRetries, CancellationToken cancellationToken);
    Task<PrintJob?> GetByIdAsync(Guid id, CancellationToken cancellationToken);
    Task<IReadOnlyList<PrintJob>> GetByStatusAsync(PrintJobStatus? status, CancellationToken cancellationToken);
    Task<PrintJob?> GetNextQueuedAsync(CancellationToken cancellationToken);
    Task<bool> RequestCancelAsync(Guid id, CancellationToken cancellationToken);
    Task UpdateStatusAsync(Guid id, PrintJobStatus status, string? message, CancellationToken cancellationToken);
    Task MarkProcessingStartAsync(Guid id, CancellationToken cancellationToken);
    Task IncrementAttemptAsync(Guid id, string? message, CancellationToken cancellationToken);
    Task RequeueInconsistentActiveJobsAsync(CancellationToken cancellationToken);
}
