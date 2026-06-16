# Integrazione Electron -> Print Broker

## Variabili ambiente richieste

### Print Broker locale

- PRINT_BROKER_URL (default: http://127.0.0.1:5177)
- PRINT_BROKER_TOKEN_HEADER (default: X-Local-Token)
- PRINT_BROKER_TOKEN (opzionale; se assente viene letto da broker.token)
- PRINT_BROKER_DATA_DIR (opzionale; directory dati broker)

### Upload SFTP

- SFTP_HOST
- SFTP_PORT (default: 22)
- SFTP_USERNAME
- SFTP_PASSWORD oppure SFTP_PRIVATE_KEY_PATH
- SFTP_REMOTE_BASE_PATH
- SFTP_EVENTS_REMOTE_PATH (opzionale; default: SFTP_REMOTE_BASE_PATH o `/`)
- SFTP_GALLERY_REMOTE_BASE_PATH (opzionale; default: cartella `images/events` accanto a SFTP_EVENTS_REMOTE_PATH)

## IPC disponibili lato renderer

- window.electronAPI.getPrinters()
- window.electronAPI.printImage(filename, printerName, options)
- window.electronAPI.getPrintJob(jobId)
- window.electronAPI.cancelPrintJob(jobId)

## Esempio printImage

options supportate:

- copies (default 1)
- paperSize (default Paper10x15)
- orientation (default Portrait)
- metadata (object)

## Note

- filename puo' essere:
  - path assoluto immagine
  - nome relativo
  - formato folder§file.jpg (risolto in Foto/folder/file.jpg)
- Se il token non e' configurato via env, Electron legge:
  - %LOCALAPPDATA%/MirrorSballando/PrintBroker/broker.token
