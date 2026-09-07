-- Forward-only migration. Roll back with a new migration containing:
-- DROP TABLE relay_quota;
CREATE TABLE IF NOT EXISTS relay_quota (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  day TEXT NOT NULL,
  day_requests INTEGER NOT NULL CHECK (day_requests >= 0),
  month TEXT NOT NULL,
  month_units INTEGER NOT NULL CHECK (month_units >= 0)
);
