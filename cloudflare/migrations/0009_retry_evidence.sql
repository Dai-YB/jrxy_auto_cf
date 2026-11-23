ALTER TABLE jobs ADD COLUMN target TEXT;
ALTER TABLE accounts ADD COLUMN submission_checkpoint TEXT;
ALTER TABLE batches ADD COLUMN fallback_reason TEXT;
ALTER TABLE execution_slots ADD COLUMN delivery_token TEXT;
CREATE INDEX jobs_account_latest ON jobs(account,mode,created_at DESC);
UPDATE jobs SET target=checkpoint WHERE checkpoint IS NOT NULL;
UPDATE accounts SET submission_checkpoint=(
  SELECT old.checkpoint FROM jobs old WHERE old.account=accounts.name AND old.mode='submit' AND old.checkpoint IS NOT NULL
    AND (old.status!='done' OR (json_valid(old.result) AND json_extract(old.result,'$.status')='uncertain'))
    AND NOT EXISTS(SELECT 1 FROM jobs newer WHERE newer.account=old.account AND newer.mode='submit' AND newer.status='done'
      AND (newer.created_at>old.created_at OR (newer.created_at=old.created_at AND newer.rowid>old.rowid))
      AND json_valid(newer.result) AND json_extract(newer.result,'$.status') IN('success','already')
      AND (newer.checkpoint IS NULL OR newer.checkpoint=old.checkpoint))
  ORDER BY old.created_at DESC,old.rowid DESC LIMIT 1
) WHERE deleted=0;
