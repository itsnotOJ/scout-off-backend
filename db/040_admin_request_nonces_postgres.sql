-- Migration 040: single-use nonces for signed admin requests (#1511) (PostgreSQL).
-- DB fallback for src/services/adminRequestNonces.ts when Redis is unavailable.

CREATE TABLE IF NOT EXISTS admin_request_nonces (
  nonce      TEXT   PRIMARY KEY,
  expires_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_request_nonces_expires_at ON admin_request_nonces (expires_at);
