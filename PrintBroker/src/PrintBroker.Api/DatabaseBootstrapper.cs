using Microsoft.EntityFrameworkCore;
using PrintBroker.Infrastructure;

namespace PrintBroker.Api;

public sealed class DatabaseBootstrapper(IServiceScopeFactory scopeFactory, ILogger<DatabaseBootstrapper> logger) : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        using var scope = scopeFactory.CreateScope();
        var factory = scope.ServiceProvider.GetRequiredService<IDbContextFactory<PrintBrokerDbContext>>();
        await using var db = await factory.CreateDbContextAsync(cancellationToken);
        await db.Database.EnsureCreatedAsync(cancellationToken);
        logger.LogInformation("Database ready");
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        return Task.CompletedTask;
    }
}
