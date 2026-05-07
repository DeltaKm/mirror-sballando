namespace PrintBroker.Api;

public sealed class LocalTokenMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context, ILocalTokenProvider tokenProvider, IConfiguration configuration)
    {
        var headerName = configuration[$"{LocalApiSecurityOptions.SectionName}:HeaderName"] ?? "X-Local-Token";
        var expected = tokenProvider.Token;

        var provided = context.Request.Headers[headerName].FirstOrDefault();
        if (string.IsNullOrWhiteSpace(provided) && context.Request.Headers.TryGetValue("Authorization", out var authValues))
        {
            var raw = authValues.FirstOrDefault();
            if (raw?.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) == true)
            {
                provided = raw[7..].Trim();
            }
        }

        if (!string.Equals(provided, expected, StringComparison.Ordinal))
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            await context.Response.WriteAsJsonAsync(new { error = "Unauthorized" });
            return;
        }

        await next(context);
    }
}
