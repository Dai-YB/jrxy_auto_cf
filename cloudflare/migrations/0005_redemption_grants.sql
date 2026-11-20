CREATE TABLE redemption_batches (
  id TEXT PRIMARY KEY,
  note TEXT NOT NULL,
  school_name TEXT NOT NULL,
  task_type INTEGER NOT NULL CHECK(task_type IN (1,2)),
  longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  latitude REAL NOT NULL CHECK(latitude BETWEEN -90 AND 90),
  address TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 3600 AND 31536000),
  redeem_before INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE redemption_codes (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES redemption_batches(id),
  code_hash TEXT NOT NULL UNIQUE,
  suffix TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unused' CHECK(status IN ('unused','reserved','used','revoked')),
  attempt_id TEXT,
  reserved_until INTEGER,
  used_at INTEGER,
  authorization_until INTEGER
);
CREATE INDEX redemption_codes_batch ON redemption_codes(batch_id,status);
CREATE INDEX redemption_reservations ON redemption_codes(status,reserved_until);
CREATE TABLE enrollment_attempts (
  id TEXT PRIMARY KEY,
  code_id TEXT NOT NULL REFERENCES redemption_codes(id),
  receipt_hash TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  identity_key TEXT,
  credentials TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verifying','ready','succeeded','failed')),
  owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  dispatched_at INTEGER NOT NULL DEFAULT 0,
  account_name TEXT,
  account_config TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL DEFAULT '',
  error_code TEXT,
  authorization_until INTEGER
);
CREATE INDEX enrollment_due ON enrollment_attempts(status,dispatched_at);
CREATE INDEX enrollment_expiry ON enrollment_attempts(expires_at);
CREATE INDEX enrollment_identity ON enrollment_attempts(identity_key,status);
ALTER TABLE accounts ADD COLUMN identity_key TEXT;
ALTER TABLE accounts ADD COLUMN grant_code_id TEXT;
ALTER TABLE accounts ADD COLUMN authorization_from INTEGER;
ALTER TABLE accounts ADD COLUMN authorization_until INTEGER;
CREATE INDEX accounts_identity ON accounts(identity_key,deleted);
CREATE UNIQUE INDEX accounts_grant_code ON accounts(grant_code_id) WHERE grant_code_id IS NOT NULL;
CREATE UNIQUE INDEX accounts_grant_identity ON accounts(identity_key) WHERE grant_code_id IS NOT NULL AND deleted=0;
CREATE INDEX accounts_grant_expiry ON accounts(authorization_until) WHERE grant_code_id IS NOT NULL;
ALTER TABLE batches ADD COLUMN privacy_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sign_log ADD COLUMN batch_id TEXT;
CREATE INDEX sign_log_batch ON sign_log(batch_id);
