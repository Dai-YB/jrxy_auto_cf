CREATE TABLE accounts (
  name TEXT PRIMARY KEY,
  config TEXT NOT NULL,
  device_id TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE schedule (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  time TEXT NOT NULL DEFAULT '22:05',
  revision INTEGER NOT NULL DEFAULT 1,
  effective_after INTEGER NOT NULL DEFAULT 0,
  last_slot TEXT
);
INSERT INTO schedule(id) VALUES(1);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL REFERENCES accounts(name),
  mode TEXT NOT NULL CHECK(mode IN ('dry','submit','login','range')),
  trigger TEXT NOT NULL CHECK(trigger IN ('manual','schedule')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  next_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  dispatched_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  owner TEXT,
  checkpoint TEXT,
  result TEXT,
  notified INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX jobs_due ON jobs(status, next_at);
CREATE INDEX jobs_dispatch ON jobs(status, dispatched_at);
CREATE INDEX jobs_account ON jobs(account, status);
CREATE INDEX jobs_finished ON jobs(finished_at);
CREATE TABLE account_locks (
  account TEXT PRIMARY KEY REFERENCES accounts(name),
  job_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  lease_until INTEGER NOT NULL
);
CREATE TABLE sign_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  account TEXT,
  kind TEXT NOT NULL,
  result TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX sign_log_time ON sign_log(ts);
