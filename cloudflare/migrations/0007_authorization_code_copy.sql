ALTER TABLE redemption_codes ADD COLUMN code_cipher TEXT;
CREATE INDEX redemption_copy_expiry ON redemption_batches(redeem_before) WHERE redeem_before IS NOT NULL;
