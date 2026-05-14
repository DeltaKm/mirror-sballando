# Print Broker (.NET 8, Windows)

Servizio locale per gestione coda di stampa fotografica 10x15 con stato job affidabile, persistenza SQLite e integrazione Electron.

## Requisiti

- Windows 10/11
- .NET SDK 8.0+
- Accesso locale alle stampanti installate su Windows

## Struttura

- `MirrorSballando.PrintBroker.sln`
- `src/PrintBroker.Api`: API locale + worker + SSE + auth token
- `src/PrintBroker.Domain`: dominio e contratti
- `src/PrintBroker.Infrastructure`: SQLite EF Core + stampa Windows + diagnostica WMI
- `tests/PrintBroker.Tests`: test minimi automatici
- `scripts/*.ps1`: build, run, test

## Endpoint

- `POST /jobs`
- `GET /jobs/{id}`
- `GET /jobs?status=`
- `POST /jobs/{id}/cancel`
- `GET /printers`
- `GET /events` (SSE)
- `GET /health`

## Sicurezza locale

- Header token: `X-Local-Token` (configurabile)
- Se `LocalApiSecurity:Token` e' vuoto, il broker genera un token e lo salva in `%LOCALAPPDATA%/MirrorSballando/PrintBroker/broker.token`.
- In alternativa si puo' usare `Authorization: Bearer <token>`.

## Configurazione

`src/PrintBroker.Api/appsettings.json`

- `PrintBroker:BaseDataDirectory`
- `PrintBroker:DatabaseFileName`
- `PrintBroker:MaxRetries`
- `PrintBroker:WorkerPollSeconds`
- `PrintBroker:PrintTimeoutSeconds`
- `PrintBroker:RetryBackoffSeconds`
- `PrintBroker:ListenUrl`
- `LocalApiSecurity:Token`
- `LocalApiSecurity:HeaderName`

Override via variabili ambiente con prefisso `PRINTBROKER_`.

Esempio:

- `PRINTBROKER_PrintBroker__ListenUrl=http://127.0.0.1:5177`
- `PRINTBROKER_LocalApiSecurity__Token=<TOKEN>`

## Esecuzione

```powershell
cd .\PrintBroker
powershell -ExecutionPolicy Bypass -File .\scripts\build.ps1 -Configuration Release
powershell -ExecutionPolicy Bypass -File .\scripts\run.ps1 -Environment Production -Url http://127.0.0.1:5177
```

## Request esempio

```json
{
  "imagePath": "E:/Mirror Sballando/mirror-sballando/Foto/evento1/shot01.jpg",
  "printerName": "Canon SELPHY CP1500",
  "copies": 1,
  "paperSize": "Paper10x15",
  "orientation": "Portrait",
  "metadata": {
    "eventId": "24",
    "sessionId": "booth-a"
  }
}
```

## Note operative

- Worker single-thread: una stampa alla volta.
- Stato job: `Queued`, `Spooling`, `Printing`, `Completed`, `Failed`, `Canceled`.
- Alla ripartenza, i job in `Spooling`/`Printing` tornano in `Queued` (oppure `Canceled` se cancel richiesto).
- Retry controllato su errori stampante/file/timeout.

## Integrazione Electron (fase 1)

1. In `main.js` sostituire la logica di stampa diretta con chiamate HTTP locali verso il broker.
2. Conservare IPC esistente (`print-image`, `get-printers`) e reindirizzare gli handler al broker.
3. Caricare token da `%LOCALAPPDATA%/MirrorSballando/PrintBroker/broker.token`.
4. `print-image` diventa `POST /jobs`.
5. `get-printers` diventa `GET /printers`.
6. Sottoscrivere `GET /events` per aggiornare UI in tempo reale.
7. `cancel` da UI invia `POST /jobs/{id}/cancel`.

## Test automatici minimi

```powershell
cd .\PrintBroker
powershell -ExecutionPolicy Bypass -File .\scripts\test.ps1
```

Coperti:

- validazione input job
- persistenza token locale

## Smoke test API locale

```powershell
cd .\PrintBroker
powershell -ExecutionPolicy Bypass -File .\scripts\smoke-test.ps1 -BaseUrl http://127.0.0.1:5177
```
