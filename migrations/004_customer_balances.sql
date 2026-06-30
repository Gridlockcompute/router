-- Off-chain $LOCK credit balances (Phase B).
-- Run in Supabase SQL Editor after 003_billing.sql.

CREATE TABLE IF NOT EXISTS customer_balances (
  owner_wallet  TEXT PRIMARY KEY,
  balance_lock  NUMERIC(20, 8) NOT NULL DEFAULT 0 CHECK (balance_lock >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_wallet  TEXT NOT NULL,
  job_id        TEXT,
  kind          TEXT NOT NULL,
  amount_lock   NUMERIC(20, 8) NOT NULL,
  balance_after NUMERIC(20, 8) NOT NULL,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_job_kind_idx
  ON credit_ledger (job_id, kind)
  WHERE job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS credit_ledger_wallet_idx ON credit_ledger (owner_wallet, created_at DESC);

ALTER TABLE customer_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role full access" ON customer_balances
  USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY "service role full access" ON credit_ledger
  USING (TRUE) WITH CHECK (TRUE);
