CREATE TABLE batches (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,
  mode TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  round INTEGER NOT NULL DEFAULT 1,
  round_due INTEGER NOT NULL,
  last_finished_at INTEGER,
  finished_at INTEGER,
  summary TEXT,
  detail TEXT
);
CREATE INDEX batches_active ON batches(finished_at, created_at);
ALTER TABLE jobs ADD COLUMN report_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN attempt_started_at INTEGER;
ALTER TABLE jobs ADD COLUMN recoveries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN notification_result TEXT;
UPDATE jobs SET batch_id=id WHERE batch_id IS NULL;
INSERT INTO batches(id,trigger,mode,label,created_at,round,round_due,finished_at)
  SELECT batch_id,trigger,mode,trigger_label,min(created_at),
    max(1,min(CASE WHEN status='pending' THEN attempts+1 ELSE 999999 END)),
    min(next_at),CASE WHEN sum(status!='done')=0 THEN max(finished_at) ELSE NULL END
  FROM jobs GROUP BY batch_id;
CREATE TABLE execution_gate (
  id INTEGER PRIMARY KEY CHECK(id=1),
  owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
INSERT INTO execution_gate(id) VALUES(1);
ALTER TABLE schedule ADD COLUMN initialized INTEGER NOT NULL DEFAULT 0;
UPDATE schedule SET initialized=1 WHERE effective_after>0 OR last_slot IS NOT NULL;
ALTER TABLE schedule ADD COLUMN last_run INTEGER;
ALTER TABLE schedule ADD COLUMN last_result TEXT;
CREATE INDEX jobs_reporting ON jobs(report_pending, status, lease_until);
