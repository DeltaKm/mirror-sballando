using System.Security.Cryptography;
using Microsoft.Extensions.Options;

namespace PrintBroker.Api;

public sealed class FileLocalTokenProvider : ILocalTokenProvider
{
    public string Token { get; }

    public FileLocalTokenProvider(IOptions<PrintBrokerOptions> brokerOptions, IOptions<LocalApiSecurityOptions> securityOptions)
    {
        var broker = brokerOptions.Value;
        var security = securityOptions.Value;

        if (!string.IsNullOrWhiteSpace(security.Token))
        {
            Token = security.Token;
            return;
        }

        var baseDir = ResolveBaseDir(broker.BaseDataDirectory);
        Directory.CreateDirectory(baseDir);

        var tokenPath = Path.Combine(baseDir, security.TokenFileName);
        if (File.Exists(tokenPath))
        {
            Token = File.ReadAllText(tokenPath).Trim();
            return;
        }

        Token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        File.WriteAllText(tokenPath, Token);
    }

    private static string ResolveBaseDir(string configured)
    {
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return configured;
        }

        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return Path.Combine(local, "MirrorSballando", "PrintBroker");
    }
}
