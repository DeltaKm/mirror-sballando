const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

class DatabaseService {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  init() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS photos (
        id TEXT PRIMARY KEY,
        event_id TEXT,
        local_path TEXT NOT NULL,
        preview_path TEXT,
        checksum_sha256 TEXT NOT NULL,
        sync_status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS upload_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        photo_id TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT,
        locked_at TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(photo_id) REFERENCES photos(id)
      );

      CREATE INDEX IF NOT EXISTS idx_upload_queue_status ON upload_queue(status);
      CREATE INDEX IF NOT EXISTS idx_photos_sync_status ON photos(sync_status);
    `);
  }

  getDb() {
    if (!this.db) {
      throw new Error('DatabaseService non inizializzato');
    }
    return this.db;
  }
}

module.exports = { DatabaseService };
