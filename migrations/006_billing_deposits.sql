-- On-chain deposit tracking (Phase C — deposit → credits).
-- Run in Supabase SQL Editor after 005_billing_invoices.sql.

CREATE TABLE IF NOT EXISTS billing_deposits (
  tx_signature   TEXT PRIMARY KEY,
  owner_wallet   TEXT NOT NULL,
  amount_lock    NUMERIC(20, 8) NOT NULL,
  deposit_vault  TEXT NOT NULL,
  confirmed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS billing_deposits_wallet_idx ON billing_deposits (owner_wallet, confirmed_at DESC);

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS escrow_customer_wallet TEXT;

ALTER TABLE billing_deposits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role full access" ON billing_deposits
  USING (TRUE) WITH CHECK (TRUE);
