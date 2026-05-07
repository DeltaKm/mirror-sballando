using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using PrintBroker.Domain;

namespace PrintBroker.Infrastructure;

public sealed class SqlitePrintJobRepository(IDbContextFactory<PrintBrokerDbContext> dbFactory) : IPrintJobRepository
{
    public async Task<PrintJob> EnqueueAsync(CreatePrintJobRequest request, int maxRetries, CancellationToken cancellationToken)
    {
        await using var db = await dbFactory.CreateDbContextAsync(cancellationToken);
        var now = DateTimeOffset.UtcNow;
        var entity = new PrintJob
        {
            Id = Guid.NewGuid(),
            ImagePath = request.ImagePath,
            PrinterName = request.PrinterName,
            Copies = request.Copies,
            PaperSize = request.PaperSize,
            Orientation = request.Orientation,
            MetadataJson = request.Metadata is null ? null : JsonSerializer.Serialize(request.Metadata),
            Status = PrintJobStatus.Queued,
            AttemptCount = 0,
            MaxRetries = maxRetries,
            CreatedAtUtc = now,
            UpdatedAtUtc = now
        };

        db.Jobs.Add(entity);
        await db.SaveChangesAsync(cancellationToken);
        return entity;
    }

    public async Task<PrintJob?> GetByIdAsync(Guid id, CancellationToken cancellationToken)
    {
        await using var db = await dbFactory.CreateDbContextAsync(cancellationToken);
        return await db.Jobs.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, cancellationToken);
    }

    public async Task<IReadOnlyList<PrintJob>> GetByStatusAsync(PrintJobStatus? status, CancellationToken cancellationToken)
    {
        await using var db = await dbFactory.CreateDbContextAsync(cancellationToken);
        var query = db.Jobs.AsNoTracking().AsQueryable();
        if (status.HasValue)
        {
            query = query.Where(x => x.Status == status.Value);
        }

        var jobs = await query.ToListAsync(cancellationToken);
        return jobs.OrderBy(x => x.CreatedAtUtc).ToList();
    }

    public async Task<PrintJob?> GetNextQueuedAsync(CancellationToken cancellationToken)
    {
        await using var db = await dbFactory.CreateDbContextAsync(cancellationToken);
        var jobs = await db.Jobs
            .Where(x => x.Status == PrintJobStatus.Queued && !x.CancelRequested)
            .ToListAsync(cancellationToken);

        return jobs.OrderBy(x => x.CreatedAtUtc).FirstOrDefault();
    }

    public async Task<bool> RequestCancelAsync(Guid id, CancellationToken cancellationToken)
    {
        await using var db = await dbFactory.CreateDbContextAsync(cancellationToken);
        var entity = await db.Jobs.FirstOrDefaultAsync(x => x.Id == id, cancellationToken);
        if (entity is null)
        {
            return false;
        }

        entity.CancelRequested = true;
        entity.UpdatedAtUtc = DateTimeOffset.UtcNow;

        if (entity.Status is PrintJobStatus.Queued)
        {
            entity.Status = PrintJobStatus.Canceled;
            entity.CompletedAtUtc = DateTimeOffset.UtcNow;
        }

        await db.SaveChangesAsync(cancellationToken);
        return true;
    }

    public async Task UpdateStatusAsync(Guid id, PrintJobStatus status, string? message, CancellationToken cancellationToken)
    {
        await using var db = await dbFactory.CreateDbContextAsync(cancellationToken);
        var entity = await db.Jobs.FirstOrDefaultAsync(x => x.Id == id, cancellationToken);
        if (entity is null)
        {
            return;
        }

        entity.Status = status;
        entity.LastError = message;
        entity.UpdatedAtUtc = DateTimeOffset.UtcNow;

        if (status is PrintJobStatus.Completed or PrintJobStatus.Failed or PrintJobStatus.Canceled)
        {
            entity.CompletedAtUtc = DateTimeOffset.UtcNow;
        }

        await db.SaveChangesAsync(cancellationToken);
    }

    public async Task MarkProcessingStartAsync(Guid id, CancellationToken cancellationToken)
    {
        await using var db = await dbFactory.CreateDbContextAsync(cancellationToken);
        var entity = await db.Jobs.FirstOrDefaultAsync(x => x.Id == id, cancellationToken);
        if (entity is null)
        {
            return;
        }

        entity.StartedAtUtc = DateTimeOffset.UtcNow;
        entity.UpdatedAtUtc = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(cancellationToken);
    }

    public async Task IncrementAttemptAsync(Guid id, string? message, CancellationToken cancellationToken)
    {
        await using var db = await dbFactory.CreateDbContextAsync(cancellationToken);
        var entity = await db.Jobs.FirstOrDefaultAsync(x => x.Id == id, cancellationToken);
        if (entity is null)
        {
            return;
        }

        entity.AttemptCount += 1;
        entity.LastError = message;
        entity.UpdatedAtUtc = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(cancellationToken);
    }

    public async Task RequeueInconsistentActiveJobsAsync(CancellationToken cancellationToken)
    {
        await using var db = await dbFactory.CreateDbContextAsync(cancellationToken);
        var affected = await db.Jobs
            .Where(x => x.Status == PrintJobStatus.Spooling || x.Status == PrintJobStatus.Printing)
            .ToListAsync(cancellationToken);

        if (affected.Count == 0)
        {
            return;
        }

        foreach (var entity in affected)
        {
            if (entity.CancelRequested)
            {
                entity.Status = PrintJobStatus.Canceled;
                entity.CompletedAtUtc = DateTimeOffset.UtcNow;
            }
            else
            {
                entity.Status = PrintJobStatus.Queued;
            }

            entity.UpdatedAtUtc = DateTimeOffset.UtcNow;
        }

        await db.SaveChangesAsync(cancellationToken);
    }
}
