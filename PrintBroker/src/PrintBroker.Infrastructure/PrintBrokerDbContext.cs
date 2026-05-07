using Microsoft.EntityFrameworkCore;
using PrintBroker.Domain;

namespace PrintBroker.Infrastructure;

public sealed class PrintBrokerDbContext(DbContextOptions<PrintBrokerDbContext> options) : DbContext(options)
{
    public DbSet<PrintJob> Jobs => Set<PrintJob>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<PrintJob>(entity =>
        {
            entity.ToTable("print_jobs");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.ImagePath).IsRequired();
            entity.Property(x => x.PrinterName).IsRequired();
            entity.Property(x => x.MetadataJson);
            entity.Property(x => x.LastError);
            entity.HasIndex(x => x.Status);
            entity.HasIndex(x => x.CreatedAtUtc);
        });
    }
}
