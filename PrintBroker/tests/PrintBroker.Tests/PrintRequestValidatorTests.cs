using PrintBroker.Api;
using PrintBroker.Domain;
using Microsoft.AspNetCore.Http;
using Xunit;

namespace PrintBroker.Tests;

public sealed class PrintRequestValidatorTests
{
    [Fact]
    public void Validate_Throws_WhenImagePathMissing()
    {
        var request = new CreatePrintJobRequest
        {
            ImagePath = "",
            PrinterName = "HP",
            Copies = 1
        };

        Assert.Throws<BadHttpRequestException>(() => PrintRequestValidator.Validate(request));
    }

    [Fact]
    public void Validate_Throws_WhenCopiesOutOfRange()
    {
        var request = new CreatePrintJobRequest
        {
            ImagePath = "c:/photo.jpg",
            PrinterName = "HP",
            Copies = 0
        };

        Assert.Throws<BadHttpRequestException>(() => PrintRequestValidator.Validate(request));
    }

    [Fact]
    public void Validate_DoesNotThrow_OnValidRequest()
    {
        var request = new CreatePrintJobRequest
        {
            ImagePath = "c:/photo.jpg",
            PrinterName = "HP",
            Copies = 1
        };

        PrintRequestValidator.Validate(request);
    }
}
