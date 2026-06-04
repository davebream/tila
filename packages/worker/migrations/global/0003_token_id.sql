-- Add token_id column; initially nullable to allow backfill of existing rows
ALTER TABLE _tokens ADD COLUMN token_id TEXT;

-- Backfill existing rows with a random opaque identifier (32-char lowercase hex)
UPDATE _tokens SET token_id = lower(hex(randomblob(16))) WHERE token_id IS NULL;

-- Add UNIQUE index
CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_token_id ON _tokens(token_id);
