using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using PrintBroker.Api;
using PrintBroker.Domain;
using PrintBroker.Infrastructure;
using Serilog;

var builder = WebApplication.CreateBuilder(args);

builder.Configuration
    .AddJsonFile("appsettings.json", optional: false, reloadOnChange: true)
    .AddJsonFile($"appsettings.{builder.Environment.EnvironmentName}.json", optional: true, reloadOnChange: true)
    .AddEnvironmentVariables(prefix: "PRINTBROKER_");

builder.Services.Configure<PrintBrokerOptions>(builder.Configuration.GetSection(PrintBrokerOptions.SectionName));
builder.Services.Configure<LocalApiSecurityOptions>(builder.Configuration.GetSection(LocalApiSecurityOptions.SectionName));

var dataDir = ResolveDataDirectory(builder.Configuration.GetSection(PrintBrokerOptions.SectionName)["BaseDataDirectory"]);
Directory.CreateDirectory(dataDir);
var dbPath = Path.Combine(dataDir, builder.Configuration.GetSection(PrintBrokerOptions.SectionName)["DatabaseFileName"] ?? "printbroker.db");

builder.Host.UseSerilog((ctx, cfg) =>
{
    var logDir = Path.Combine(dataDir, "logs");
    Directory.CreateDirectory(logDir);

    cfg.ReadFrom.Configuration(ctx.Configuration)
       .Enrich.FromLogContext()
       .WriteTo.File(Path.Combine(logDir, "printbroker-.log"), rollingInterval: RollingInterval.Day, retainedFileCountLimit: 14);
});

builder.Services.AddPrintBrokerInfrastructure($"Data Source={dbPath}");
builder.Services.AddSingleton<IJobStatusStream, ChannelJobStatusStream>();
builder.Services.AddSingleton<ILocalTokenProvider, FileLocalTokenProvider>();
builder.Services.AddHostedService<DatabaseBootstrapper>();
builder.Services.AddHostedService<JobWorker>();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter());
});

var app = builder.Build();

app.UseMiddleware<ExceptionMiddleware>();
app.UseMiddleware<LocalTokenMiddleware>();

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.MapPost("/jobs", async (
    [FromBody] CreatePrintJobRequest request,
    IPrintJobRepository repository,
    IOptions<PrintBrokerOptions> options,
    CancellationToken cancellationToken) =>
{
    PrintRequestValidator.Validate(request);
    var job = await repository.EnqueueAsync(request, options.Value.MaxRetries, cancellationToken);
    return Results.Accepted($"/jobs/{job.Id}", job);
});

app.MapGet("/jobs/{id:guid}", async (Guid id, IPrintJobRepository repository, CancellationToken cancellationToken) =>
{
    var job = await repository.GetByIdAsync(id, cancellationToken);
    return job is null ? Results.NotFound() : Results.Ok(job);
});

app.MapGet("/jobs", async ([FromQuery] string? status, IPrintJobRepository repository, CancellationToken cancellationToken) =>
{
    PrintJobStatus? parsed = null;
    if (!string.IsNullOrWhiteSpace(status))
    {
        if (!Enum.TryParse<PrintJobStatus>(status, true, out var value))
        {
            return Results.BadRequest(new { error = "Invalid status" });
        }

        parsed = value;
    }

    var jobs = await repository.GetByStatusAsync(parsed, cancellationToken);
    return Results.Ok(jobs);
});

app.MapPost("/jobs/{id:guid}/cancel", async (Guid id, IPrintJobRepository repository, IJobStatusStream stream, CancellationToken cancellationToken) =>
{
    var exists = await repository.RequestCancelAsync(id, cancellationToken);
    if (!exists)
    {
        return Results.NotFound();
    }

    stream.Publish(new PrintJobStatusEvent
    {
        JobId = id,
        Status = PrintJobStatus.Canceled,
        TimestampUtc = DateTimeOffset.UtcNow,
        Message = "CancelRequested"
    });

    return Results.Accepted($"/jobs/{id}", new { id, status = "CancelRequested" });
});

app.MapGet("/printers", async (IPrinterService printerService, CancellationToken cancellationToken) =>
{
    var printers = await printerService.GetPrintersAsync(cancellationToken);
    return Results.Ok(printers);
});

app.MapGet("/events", async (HttpContext context, IJobStatusStream stream, CancellationToken cancellationToken) =>
{
    context.Response.Headers.ContentType = "text/event-stream";
    await foreach (var evt in stream.Subscribe(cancellationToken))
    {
        var payload = JsonSerializer.Serialize(evt);
        await context.Response.WriteAsync($"event: job-status\n", cancellationToken);
        await context.Response.WriteAsync($"data: {payload}\n\n", cancellationToken);
        await context.Response.Body.FlushAsync(cancellationToken);
    }
});

app.MapGet("/health", () => Results.Ok(new { status = "ok" }));

var listen = builder.Configuration.GetSection(PrintBrokerOptions.SectionName)["ListenUrl"];
if (!string.IsNullOrWhiteSpace(listen))
{
    app.Urls.Clear();
    app.Urls.Add(listen);
}

app.Run();

static string ResolveDataDirectory(string? configured)
{
    if (!string.IsNullOrWhiteSpace(configured))
    {
        return configured;
    }

    var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    return Path.Combine(local, "MirrorSballando", "PrintBroker");
}
