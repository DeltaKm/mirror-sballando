Agisci come Software Architect + Senior Developer .NET 8 su Windows.

Contesto:
- Ho un’app Electron esistente in questa cartella: <PERCORSO_PROGETTO>
- L’app gestisce foto/eventi e oggi la stampa è fragile (file-segnale, path hardcoded, controllo esterno).
- Obiettivo: integrare la gestione code di stampa dentro il programma, con stato certo dei job, senza dover controllare separatamente.

Obiettivo tecnico (FASE 1, prioritaria):
- NON fare rewrite totale UI adesso.
- Crea un servizio locale in C# (.NET 8) chiamato "Print Broker" che:
  1) riceve richieste di stampa dall’app,
  2) mette in coda i job,
  3) invia i job alla stampante Windows,
  4) traccia lo stato reale (Queued, Spooling, Printing, Completed, Failed, Canceled),
  5) espone API locali per stato, elenco stampanti, annullo job.

Requisiti obbligatori:
1. Windows-only, robusto per uso totem/evento.
2. Coda persistente su SQLite (riprende dopo riavvio).
3. Nessun path hardcoded tipo C:\Users\Utente\...
4. Nessuna credenziale hardcoded nel codice.
5. Gestione errori stampante (offline, carta finita, timeout, jam) con retry controllato.
6. Log strutturati (Serilog) + file log rotanti.
7. Endpoint locali:
   - POST /jobs
   - GET /jobs/{id}
   - GET /jobs?status=
   - POST /jobs/{id}/cancel
   - GET /printers
8. Worker coda single-thread (una stampa alla volta) configurabile.
9. Notifiche stato in tempo reale via SSE o WebSocket.
10. API protetta localmente (token locale o named pipe security).

Formato stampa:
- Input job: imagePath, printerName, copies, paperSize (10x15), orientation, metadata.
- Implementa stampa fotografica coerente con layout 10x15 (senza ridimensionamenti casuali).

Output che voglio da te (in ordine):
A) Analisi rapida del codice esistente e mappa problemi.
B) Architettura proposta (componenti + flow).
C) Struttura progetto .NET (solution + progetti).
D) Codice completo iniziale compilabile.
E) Script/command per build e avvio su Windows.
F) Piano integrazione Electron -> Print Broker (passi concreti).
G) Checklist test manuali + test minimi automatici.

Vincoli di qualità:
- Codice pulito, SOLID dove utile, niente over-engineering.
- Configurazione via appsettings.json + variabili ambiente.
- Usa CancellationToken, timeout espliciti, handling eccezioni centralizzato.
- Se una scelta tecnica è incerta, proponi 2 opzioni con pro/contro e scegli quella consigliata.

Prima di scrivere codice:
1) elenca assunzioni,
2) chiedi eventuali dati mancanti,
3) poi procedi direttamente con implementazione.