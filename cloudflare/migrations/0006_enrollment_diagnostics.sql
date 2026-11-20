ALTER TABLE enrollment_attempts ADD COLUMN diagnostic TEXT;
CREATE INDEX enrollment_recent ON enrollment_attempts(created_at DESC);
