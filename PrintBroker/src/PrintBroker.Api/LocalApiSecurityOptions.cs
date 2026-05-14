namespace PrintBroker.Api;

public sealed class LocalApiSecurityOptions
{
    public const string SectionName = "LocalApiSecurity";

    public string? Token { get; set; }
    public string TokenFileName { get; set; } = "broker.token";
    public string HeaderName { get; set; } = "X-Local-Token";
}
