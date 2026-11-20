ALTER TABLE jobs ADD COLUMN trigger_label TEXT NOT NULL DEFAULT '手动';
ALTER TABLE jobs ADD COLUMN batch_id TEXT;
ALTER TABLE jobs ADD COLUMN sequence_no INTEGER NOT NULL DEFAULT 0;
CREATE INDEX jobs_batch ON jobs(batch_id,status);
