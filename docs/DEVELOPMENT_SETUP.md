# Development Setup

## Prerequisiti Windows
1. Node.js LTS 22.x (include npm)
2. Git
3. Visual Studio Build Tools (consigliato per moduli nativi)

## Verifica rapida
- node -v
- npm -v

## Installazione dipendenze
- npm install

## Modalita sviluppo (hot reload)
- npm run dev

Cosa avvia:
- Vite dev server React con Fast Refresh
- Electron main process con reload automatico (electronmon)

## Build produzione
- npm run build

Output previsto:
- dist/renderer (UI React)
- release (installer Windows con electron-builder)

## Note offline-first
- SQLite locale in storage/mirror.db
- Foto e asset runtime in storage/*
- La sincronizzazione cloud e asincrona e non blocca il flusso kiosk
