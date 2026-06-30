-- Gridlock — Supabase initial schema
-- Run once in: supabase.com → project → SQL Editor → New query

-- ── Jobs ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  customer         TEXT,
  model            TEXT,
  sla_tier         TEXT,
  ttft_ms          INTEGER,
  tpot_ms          INTEGER,
  sla_met          BOOLEAN,
  confidential     BOOLEAN,
  worker           TEXT,
  worker_address   TEXT,
  ts               FLOAT,
  penalty_paid     FLOAT,
  fee              FLOAT,
  status           TEXT,
  attestation_hash TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS jobs_ts_idx           ON jobs (ts DESC);
CREATE INDEX IF NOT EXISTS jobs_sla_tier_idx     ON jobs (sla_tier);
CREATE INDEX IF NOT EXISTS jobs_worker_addr_idx  ON jobs (worker_address);

-- ── Workers ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workers (
  address           TEXT PRIMARY KEY,
  role              TEXT,
  endpoint          TEXT,
  sla_tiers         TEXT,        -- JSON array stored as text
  tee_capable       BOOLEAN,
  reliability_score INTEGER,
  goodput_score     INTEGER,
  sla_pass_rate     FLOAT,
  p99_ttft_ms       INTEGER,
  status            TEXT,
  staked_lock       INTEGER,
  hardware_tier     TEXT,
  jobs_today        INTEGER,
  earnings_today    FLOAT,
  penalties_paid    INTEGER,
  is_confidential   BOOLEAN,
  last_heartbeat    FLOAT,
  registered_at     FLOAT,
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── API Keys ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
  key          TEXT PRIMARY KEY,
  name         TEXT,
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

-- ── Row-level security (optional but recommended) ────────────────────────────
-- Enable RLS on jobs so only service-role key can write
ALTER TABLE jobs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE workers ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (your SUPABASE_KEY is the service role key)
CREATE POLICY "service role full access" ON jobs
  USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY "service role full access" ON workers
  USING (TRUE) WITH CHECK (TRUE);
