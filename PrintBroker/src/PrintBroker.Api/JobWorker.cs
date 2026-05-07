using PrintBroker.Domain;
using Microsoft.Extensions.Options;

namespace PrintBroker.Api;

public sealed class JobWorker(
    IPrintJobRepository repository,
    IPrinterService printerService,
    IJobStatusStream statusStream,
    IOptions<PrintBrokerOptions> options,
    ILogger<JobWorker> logger) : BackgroundService
{
    private readonly PrintBrokerOptions _options = options.Value;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await repository.RequeueInconsistentActiveJobsAsync(stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            var next = await repository.GetNextQueuedAsync(stoppingToken);
            if (next is null)
            {
                await Task.Delay(TimeSpan.FromSeconds(_options.WorkerPollSeconds), stoppingToken);
                continue;
            }

            await ProcessJobAsync(next, stoppingToken);
        }
    }

    private async Task ProcessJobAsync(PrintJob job, CancellationToken stoppingToken)
    {
        await repository.MarkProcessingStartAsync(job.Id, stoppingToken);

        for (var attempt = job.AttemptCount + 1; attempt <= job.MaxRetries + 1; attempt++)
        {
            if (stoppingToken.IsCancellationRequested)
            {
                break;
            }

            var current = await repository.GetByIdAsync(job.Id, stoppingToken);
            if (current is null)
            {
                return;
            }

            if (current.CancelRequested)
            {
                await TransitionAsync(job.Id, PrintJobStatus.Canceled, "CancelRequested", stoppingToken);
                return;
            }

            try
            {
                await repository.IncrementAttemptAsync(job.Id, null, stoppingToken);
                await TransitionAsync(job.Id, PrintJobStatus.Spooling, $"Attempt {attempt}", stoppingToken);
                await TransitionAsync(job.Id, PrintJobStatus.Printing, null, stoppingToken);

                await printerService.PrintAsync(current, TimeSpan.FromSeconds(_options.PrintTimeoutSeconds), stoppingToken);

                await TransitionAsync(job.Id, PrintJobStatus.Completed, null, stoppingToken);
                return;
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Print attempt {Attempt} failed for job {JobId}", attempt, job.Id);
                var message = ex.Message;

                if (attempt > current.MaxRetries)
                {
                    await TransitionAsync(job.Id, PrintJobStatus.Failed, message, stoppingToken);
                    return;
                }

                await TransitionAsync(job.Id, PrintJobStatus.Queued, $"Retrying: {message}", stoppingToken);
                await Task.Delay(TimeSpan.FromSeconds(_options.RetryBackoffSeconds), stoppingToken);
            }
        }
    }

    private async Task TransitionAsync(Guid jobId, PrintJobStatus status, string? message, CancellationToken cancellationToken)
    {
        await repository.UpdateStatusAsync(jobId, status, message, cancellationToken);
        statusStream.Publish(new PrintJobStatusEvent
        {
            JobId = jobId,
            Status = status,
            TimestampUtc = DateTimeOffset.UtcNow,
            Message = message
        });
    }
}
