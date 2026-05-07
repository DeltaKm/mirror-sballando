using PrintBroker.Domain;

namespace PrintBroker.Api;

public interface IJobStatusStream
{
    void Publish(PrintJobStatusEvent evt);
    IAsyncEnumerable<PrintJobStatusEvent> Subscribe(CancellationToken cancellationToken);
}
