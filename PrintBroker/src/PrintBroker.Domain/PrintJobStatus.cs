namespace PrintBroker.Domain;

public enum PrintJobStatus
{
    Queued = 0,
    Spooling = 1,
    Printing = 2,
    Completed = 3,
    Failed = 4,
    Canceled = 5
}
