-- Customer API keys (wallet-owned, hashed at rest).
-- Replaces the unused 001 api_keys stub.

DROP TABLE IF EXISTS api_keys;

CREATE TABLE api_keys (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash       TEXT NOT NULL UNIQUE,
  key_prefix     TEXT NOT NULL,
  owner_wallet   TEXT NOT NULL,
  name           TEXT NOT NULL,
  default_sla    TEXT NOT NULL DEFAULT 'standard',
  tee_required   BOOLEAN NOT NULL DEFAULT FALSE,
  allowed_ips    TEXT[] DEFAULT NULL,
  request_count  BIGINT NOT NULL DEFAULT 0,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS api_keys_owner_wallet_idx ON api_keys (owner_wallet);
CREATE INDEX IF NOT EXISTS api_keys_key_hash_idx ON api_keys (key_hash) WHERE is_active = TRUE;

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role full access" ON api_keys
  USING (TRUE) WITH CHECK (TRUE);
