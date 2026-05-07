using Microsoft.Extensions.Options;
using PrintBroker.Api;
using Xunit;

namespace PrintBroker.Tests;

public sealed class FileLocalTokenProviderTests
{
    [Fact]
    public void UsesConfiguredToken_WhenProvided()
    {
        var broker = Options.Create(new PrintBrokerOptions
        {
            BaseDataDirectory = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"))
        });

        var security = Options.Create(new LocalApiSecurityOptions
        {
            Token = "fixed-token"
        });

        var provider = new FileLocalTokenProvider(broker, security);
        Assert.Equal("fixed-token", provider.Token);
    }

    [Fact]
    public void PersistsTokenToFile_WhenNotConfigured()
    {
        var baseDir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        var broker = Options.Create(new PrintBrokerOptions
        {
            BaseDataDirectory = baseDir
        });

        var security = Options.Create(new LocalApiSecurityOptions
        {
            Token = "",
            TokenFileName = "broker.token"
        });

        var p1 = new FileLocalTokenProvider(broker, security);
        var p2 = new FileLocalTokenProvider(broker, security);

        Assert.False(string.IsNullOrWhiteSpace(p1.Token));
        Assert.Equal(p1.Token, p2.Token);
    }
}
