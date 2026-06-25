-- Migration 0020: add cnf_jkt column to _tokens for DPoP sender-constrained binding.
-- NULL = unbound (today's behaviour); non-NULL = JWK thumbprint the bearer must prove.
ALTER TABLE _tokens ADD COLUMN cnf_jkt TEXT;
