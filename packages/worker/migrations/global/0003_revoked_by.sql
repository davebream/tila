-- Add revoked_by attribution to token revocation
ALTER TABLE _tokens ADD COLUMN revoked_by TEXT;
