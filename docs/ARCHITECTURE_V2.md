# Mirror Sballando - Architecture V2

## Visione
Applicazione desktop Electron professionale, offline-first, modulare e stabile per eventi reali.

## Layer principali

1. Renderer/UI (React + Tailwind + Framer Motion)
- Kiosk mode touch-first
- Admin panel operativo
- Nessuna logica critica di business nel renderer

2. Electron Main Process
- Orchestrazione runtime
- Accesso filesystem e stampanti
- Boot dei servizi locali

3. Services locali
- CameraService: discovery/gestione camere
- PrintService: coda e invio stampa locale
- UploadService: API cloud idempotenti
- SyncService: motore di sincronizzazione background
- StorageService: lifecycle file locali
- SettingsService: configurazioni runtime
- EventService: contesto evento corrente

4. Database SQLite locale (master)
- Tabella photos
- Tabella upload_queue
- Stato sincronizzazione persistente

5. File storage locale
- storage/photos
- storage/previews
- storage/prints
- storage/templates
- storage/logs
- storage/cache

6. Sync engine cloud
- Il cloud e replica, non sorgente primaria
- Retry automatici e consistenza
- Nessuna perdita foto in caso di rete instabile

## Flusso offline-first foto
1. Scatto
2. Salvataggio locale su storage/photos
3. Inserimento metadata su SQLite
4. Inserimento in upload_queue
5. SyncService processa coda
6. Aggiornamento stato: LOCAL_ONLY -> PENDING_UPLOAD -> UPLOADING -> SYNCED/ERROR

## IPC architecture
- Canali centralizzati in src/main/ipc/channels.js
- Handler registrati in src/main/ipc/registerIpcHandlers.js
- Preload espone API minimali e sicure in window.mirrorApi

## Regole di stabilita
- No dipendenza cloud per operazioni core kiosk
- Timeout espliciti e retry con backoff
- Logging strutturato su file locali
- Main process sempre authority sulle operazioni critiche

## Step successivi consigliati
1. Implementare capture pipeline con CameraService + Sharp
2. Implementare PrintService reale (pdf-to-printer) con template Konva
3. Implementare UploadService verso endpoint cloud idempotente
4. Arricchire Admin panel con monitor queue/live status
5. Aggiungere test automatici su servizi e migrazioni DB
