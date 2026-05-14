# Module Responsibilities

## src/renderer
- kiosk: esperienza touch-screen per uso pubblico
- admin: pannello controllo staff evento
- components: UI riusabili
- layouts: shell visuali kiosk/admin
- hooks: logica UI e polling stato
- animations: preset Framer Motion
- styles: Tailwind base

## src/main
- index.js: bootstrap runtime e finestra Electron
- preload.js: bridge sicuro renderer/main
- ipc: canali e handler
- services: dominio applicativo locale
- database: accesso SQLite e migrazioni
- utils: path, logger, helper trasversali

## storage
- photos: originali scattate
- previews: anteprime compresse
- prints: artefatti pronti stampa
- templates: layout JSON/Konva
- logs: log runtime/operativi
- cache: file temporanei non critici
