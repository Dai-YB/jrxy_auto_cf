ALTER TABLE accounts ADD COLUMN priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 100);
ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 100);
ALTER TABLE jobs ADD COLUMN wave_no INTEGER NOT NULL DEFAULT 0;
UPDATE jobs SET wave_no=sequence_no;
ALTER TABLE batches ADD COLUMN concurrency_limit INTEGER NOT NULL DEFAULT 1 CHECK(concurrency_limit BETWEEN 1 AND 3);
CREATE INDEX jobs_wave ON jobs(batch_id,priority DESC,wave_no,status,report_pending);
CREATE TABLE execution_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  parallelism INTEGER NOT NULL DEFAULT 1 CHECK(parallelism BETWEEN 1 AND 3)
);
INSERT INTO execution_settings(id) VALUES(1);
CREATE TABLE execution_slots (
  id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 3),
  kind TEXT CHECK(kind IN('job','enrollment')),
  task_id TEXT,
  owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  UNIQUE(kind,task_id)
);
INSERT INTO execution_slots(id) VALUES(1),(2),(3);
