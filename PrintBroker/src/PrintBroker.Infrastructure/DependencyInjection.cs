using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using PrintBroker.Domain;

namespace PrintBroker.Infrastructure;

public static class DependencyInjection
{
    public static IServiceCollection AddPrintBrokerInfrastructure(this IServiceCollection services, string connectionString)
    {
        services.AddDbContextFactory<PrintBrokerDbContext>(options => options.UseSqlite(connectionString));
        services.AddScoped<IPrintJobRepository, SqlitePrintJobRepository>();
        services.AddSingleton<IPrinterDiagnostics, WmiPrinterDiagnostics>();
        services.AddSingleton<IPrinterService, WindowsPrinterService>();
        return services;
    }
}
