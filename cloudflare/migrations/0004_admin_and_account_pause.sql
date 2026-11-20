ALTER TABLE accounts ADD COLUMN paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1));
ALTER TABLE accounts ADD COLUMN pause_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN resume_after INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN account_version INTEGER NOT NULL DEFAULT 0;
CREATE INDEX accounts_active ON accounts(deleted,paused,name);
CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  credential_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at);
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX rate_limits_expiry ON rate_limits(expires_at);
