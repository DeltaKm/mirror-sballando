const { randomUUID } = require('node:crypto');
const { createHash } = require('node:crypto');
const fs = require('node:fs');

const SyncStatus = {
  LOCAL_ONLY: 'LOCAL_ONLY',
  PENDING_UPLOAD: 'PENDING_UPLOAD',
  UPLOADING: 'UPLOADING',
  SYNCED: 'SYNCED',
  ERROR: 'ERROR'
};

class SyncService {
  constructor(databaseService) {
    this.databaseService = databaseService;
    this.syncLoop = null;
  }

  start() {
    if (this.syncLoop) {
      return;
    }
    this.syncLoop = setInterval(() => this.processQueue(), 5000);
  }

  stop() {
    if (this.syncLoop) {
      clearInterval(this.syncLoop);
      this.syncLoop = null;
    }
  }

  getOverview() {
    const db = this.databaseService.getDb();
    const pending = db.prepare('SELECT COUNT(*) as count FROM upload_queue WHERE status IN (\'PENDING_UPLOAD\', \'ERROR\')').get();
    return {
      online: true,
      pending: pending.count
    };
  }

  registerLocalPhoto({ localPath, eventId = null }) {
    const db = this.databaseService.getDb();
    const id = randomUUID();
    const checksum = this.sha256File(localPath);
    const now = new Date().toISOString();

    db.prepare(
      'INSERT INTO photos(id, event_id, local_path, preview_path, checksum_sha256, sync_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, eventId, localPath, null, checksum, SyncStatus.PENDING_UPLOAD, now, now);

    db.prepare(
      'INSERT INTO upload_queue(photo_id, attempts, next_retry_at, locked_at, status, created_at, updated_at) VALUES (?, 0, NULL, NULL, ?, ?, ?)'
    ).run(id, SyncStatus.PENDING_UPLOAD, now, now);

    return { id, checksum, syncStatus: SyncStatus.PENDING_UPLOAD };
  }

  processQueue() {
    const db = this.databaseService.getDb();
    const now = new Date().toISOString();

    const row = db.prepare(
      `SELECT q.id, q.photo_id, q.attempts
       FROM upload_queue q
       WHERE q.status IN ('PENDING_UPLOAD', 'ERROR')
       ORDER BY q.id ASC
       LIMIT 1`
    ).get();

    if (!row) {
      return;
    }

    db.prepare('UPDATE upload_queue SET status = ?, updated_at = ? WHERE id = ?').run(SyncStatus.UPLOADING, now, row.id);
    db.prepare('UPDATE photos SET sync_status = ?, updated_at = ? WHERE id = ?').run(SyncStatus.UPLOADING, now, row.photo_id);

    // Placeholder idempotent upload call.
    db.prepare('UPDATE upload_queue SET status = ?, updated_at = ? WHERE id = ?').run(SyncStatus.SYNCED, now, row.id);
    db.prepare('UPDATE photos SET sync_status = ?, updated_at = ? WHERE id = ?').run(SyncStatus.SYNCED, now, row.photo_id);
  }

  sha256File(filePath) {
    const hash = createHash('sha256');
    const content = fs.readFileSync(filePath);
    hash.update(content);
    return hash.digest('hex');
  }
}

module.exports = { SyncService, SyncStatus };
