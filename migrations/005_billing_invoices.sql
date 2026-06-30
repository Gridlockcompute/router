-- Monthly billing invoices + per-job settlement tx (Phase C).
-- Run in Supabase SQL Editor after 004_customer_balances.sql.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS settlement_tx TEXT;

CREATE TABLE IF NOT EXISTS billing_invoices (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_wallet            TEXT NOT NULL,
  period_year             INTEGER NOT NULL,
  period_month            INTEGER NOT NULL,
  period_label            TEXT NOT NULL,
  amount_lock             NUMERIC(20, 8) NOT NULL DEFAULT 0,
  penalties_credited_lock NUMERIC(20, 8) NOT NULL DEFAULT 0,
  request_count           INTEGER NOT NULL DEFAULT 0,
  token_count             BIGINT NOT NULL DEFAULT 0,
  status                  TEXT NOT NULL DEFAULT 'open',
  settlement_tx           TEXT,
  settled_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_wallet, period_year, period_month)
);

CREATE INDEX IF NOT EXISTS billing_invoices_wallet_idx
  ON billing_invoices (owner_wallet, period_year DESC, period_month DESC);

ALTER TABLE billing_invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role full access" ON billing_invoices
  USING (TRUE) WITH CHECK (TRUE);
