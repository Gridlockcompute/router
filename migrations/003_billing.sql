-- Billing: link jobs to wallet owners and track token usage.
-- Run in Supabase SQL Editor after 002_api_keys.sql.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS owner_wallet TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS api_key_id UUID REFERENCES api_keys(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS completion_tokens INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS jobs_owner_wallet_ts_idx ON jobs (owner_wallet, ts DESC);
CREATE INDEX IF NOT EXISTS jobs_api_key_id_idx ON jobs (api_key_id) WHERE api_key_id IS NOT NULL;

-- Backfill owner_wallet from customer where customer looks like a full wallet pubkey.
UPDATE jobs
SET owner_wallet = customer
WHERE owner_wallet IS NULL
  AND customer IS NOT NULL
  AND length(customer) >= 32;
