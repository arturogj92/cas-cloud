const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');

class SqliteDeviceStore {
  constructor(filename) {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS mobile_devices (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, runtime_id TEXT NOT NULL,
      device_id TEXT NOT NULL, device_name TEXT NOT NULL, public_key TEXT NOT NULL,
      refresh_token_hash TEXT UNIQUE, token_updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, revoked_at TEXT,
      expo_push_token TEXT, push_platform TEXT,
      UNIQUE(user_id, runtime_id, device_id)
    )`);
  }

  upsert(device) {
    const now = new Date().toISOString();
    return this.db.prepare(`INSERT INTO mobile_devices
      (id, user_id, runtime_id, device_id, device_name, public_key, refresh_token_hash,
       token_updated_at, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, runtime_id, device_id) DO UPDATE SET
        device_name=excluded.device_name, public_key=excluded.public_key,
        refresh_token_hash=excluded.refresh_token_hash, token_updated_at=excluded.token_updated_at,
        last_seen_at=excluded.last_seen_at, revoked_at=NULL, expo_push_token=NULL, push_platform=NULL
      RETURNING *`).get(randomUUID(), device.userId, device.runtimeId, device.deviceId,
      device.deviceName, device.publicKey, device.refreshTokenHash, now, now, now);
  }

  rotateRefreshToken(previous, next) {
    const now = new Date().toISOString();
    return this.db.prepare(`UPDATE mobile_devices SET refresh_token_hash=?, token_updated_at=?, last_seen_at=?
      WHERE refresh_token_hash=? AND revoked_at IS NULL RETURNING *`).get(next, now, now, previous);
  }

  findRecentRefreshToken(hash, after) {
    return this.db.prepare(`SELECT * FROM mobile_devices WHERE refresh_token_hash=?
      AND token_updated_at>=? AND revoked_at IS NULL`).get(hash, after);
  }

  list(userId) {
    return this.db.prepare(`SELECT id,runtime_id,device_id,device_name,last_seen_at,created_at,revoked_at
      FROM mobile_devices WHERE user_id=? AND revoked_at IS NULL ORDER BY last_seen_at DESC`).all(userId);
  }

  savePushToken({ userId, runtimeId, deviceId, token, platform }) {
    return Boolean(this.db.prepare(`UPDATE mobile_devices SET expo_push_token=?, push_platform=?, last_seen_at=?
      WHERE user_id=? AND runtime_id=? AND device_id=? AND revoked_at IS NULL`)
      .run(token, platform, new Date().toISOString(), userId, runtimeId, deviceId).changes);
  }

  listPushTokens(userId, runtimeId) {
    return this.db.prepare(`SELECT expo_push_token,device_id,push_platform FROM mobile_devices
      WHERE user_id=? AND (? IS NULL OR runtime_id=?) AND revoked_at IS NULL AND expo_push_token IS NOT NULL`)
      .all(userId, runtimeId || null, runtimeId || null);
  }

  revokeByRefreshTokens(hashes) {
    return this.db.transaction(() => hashes.reduce((count, hash) => count + this.db.prepare(`UPDATE mobile_devices
      SET revoked_at=?, refresh_token_hash=NULL, expo_push_token=NULL, push_platform=NULL
      WHERE refresh_token_hash=? AND revoked_at IS NULL`).run(new Date().toISOString(), hash).changes, 0))() > 0;
  }

  revoke(userId, id) {
    return Boolean(this.db.prepare(`UPDATE mobile_devices
      SET revoked_at=?, refresh_token_hash=NULL, expo_push_token=NULL, push_platform=NULL
      WHERE user_id=? AND id=? AND revoked_at IS NULL`).run(new Date().toISOString(), userId, id).changes);
  }

  // Self-hosted diagnostics stay in the route's local logs; no analytics database is required.
  async recordReconnectTelemetry() {}
  async recordCommandTelemetry() {}
  close() { this.db.close(); }
}

module.exports = { SqliteDeviceStore };
