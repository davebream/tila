-- Rate limiting table for distributed auth failure tracking
CREATE TABLE IF NOT EXISTS _rate_limits (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
