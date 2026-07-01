-- Worker earnings ledger + SOL withdrawals (Phase D).
-- Run in Supabase SQL Editor after 007_stake.sql.

CREATE TABLE IF NOT EXISTS worker_earnings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_wallet   TEXT NOT NULL,
  job_id          TEXT NOT NULL UNIQUE,
  fee_credits     NUMERIC(20, 8) NOT NULL,
  share_bps       INTEGER NOT NULL,
  earning_credits NUMERIC(20, 8) NOT NULL,
  boosted         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS worker_earnings_wallet_idx
  ON worker_earnings (worker_wallet, created_at DESC);

CREATE TABLE IF NOT EXISTS worker_payouts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_wallet    TEXT NOT NULL,
  amount_credits   NUMERIC(20, 8) NOT NULL,
  amount_lamports  BIGINT NOT NULL,
  dest_address     TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending_transfer'
    CHECK (status IN ('pending_transfer', 'completed', 'failed')),
  tx_signature     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS worker_payouts_wallet_idx
  ON worker_payouts (worker_wallet, created_at DESC);

CREATE INDEX IF NOT EXISTS worker_payouts_inflight_idx
  ON worker_payouts (worker_wallet, status)
  WHERE status = 'pending_transfer';

ALTER TABLE worker_earnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_payouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role full access" ON worker_earnings
  USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY "service role full access" ON worker_payouts
  USING (TRUE) WITH CHECK (TRUE);
