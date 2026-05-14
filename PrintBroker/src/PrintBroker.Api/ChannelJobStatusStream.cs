using System.Threading.Channels;
using System.Collections.Concurrent;
using PrintBroker.Domain;

namespace PrintBroker.Api;

public sealed class ChannelJobStatusStream : IJobStatusStream
{
    private readonly ConcurrentDictionary<Guid, Channel<PrintJobStatusEvent>> _subscribers = new();

    public void Publish(PrintJobStatusEvent evt)
    {
        foreach (var subscriber in _subscribers.Values)
        {
            subscriber.Writer.TryWrite(evt);
        }
    }

    public async IAsyncEnumerable<PrintJobStatusEvent> Subscribe([System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var id = Guid.NewGuid();
        var channel = Channel.CreateUnbounded<PrintJobStatusEvent>();
        _subscribers[id] = channel;

        try
        {
            while (await channel.Reader.WaitToReadAsync(cancellationToken))
            {
                while (channel.Reader.TryRead(out var item))
                {
                    yield return item;
                }
            }
        }
        finally
        {
            _subscribers.TryRemove(id, out _);
            channel.Writer.TryComplete();
        }
    }
}
