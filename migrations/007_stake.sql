-- Staking deposit audit + unstake cooldown tracking (Phase C).
-- Run in Supabase SQL Editor after 006_billing_deposits.sql.

CREATE TABLE IF NOT EXISTS stake_deposits (
  tx_signature   TEXT PRIMARY KEY,
  owner_wallet   TEXT NOT NULL,
  amount_lock    NUMERIC(20, 8) NOT NULL,
  vault_ata      TEXT NOT NULL,
  confirmed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS stake_deposits_wallet_idx ON stake_deposits (owner_wallet, confirmed_at DESC);

CREATE TABLE IF NOT EXISTS stake_unstake_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_wallet     TEXT NOT NULL,
  amount_lock      NUMERIC(20, 8) NOT NULL,
  requested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unlock_at        TIMESTAMPTZ NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'cancelled')),
  claim_tx         TEXT,
  claimed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS stake_unstake_wallet_idx
  ON stake_unstake_requests (owner_wallet, status, unlock_at DESC);

ALTER TABLE stake_deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE stake_unstake_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role full access" ON stake_deposits
  USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY "service role full access" ON stake_unstake_requests
  USING (TRUE) WITH CHECK (TRUE);
