-- Forward-only migration. Roll back with a new migration containing:
-- DROP TABLE relay_circuit;
CREATE TABLE IF NOT EXISTS relay_circuit (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  retry_at INTEGER NOT NULL CHECK (retry_at >= 0)
);

INSERT OR IGNORE INTO relay_circuit (singleton, retry_at) VALUES (1, 0);
