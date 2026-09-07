ALTER TABLE relay_quota
ADD COLUMN day_units INTEGER NOT NULL DEFAULT 0 CHECK (day_units >= 0);
