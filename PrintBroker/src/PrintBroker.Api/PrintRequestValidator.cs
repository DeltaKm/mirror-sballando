using PrintBroker.Domain;

namespace PrintBroker.Api;

public static class PrintRequestValidator
{
    public static void Validate(CreatePrintJobRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.ImagePath))
        {
            throw new BadHttpRequestException("imagePath is required");
        }

        if (string.IsNullOrWhiteSpace(request.PrinterName))
        {
            throw new BadHttpRequestException("printerName is required");
        }

        if (request.Copies < 1 || request.Copies > 20)
        {
            throw new BadHttpRequestException("copies must be between 1 and 20");
        }
    }
}
