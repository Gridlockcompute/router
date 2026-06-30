# Gridlock — My Preset

Copy `.env` to `gridlock-backend/.env` and start the backend:

```bash
cd gridlock-backend
npm install
npm run dev
```

## Services wired in

| Service    | Detail                                      |
|------------|---------------------------------------------|
| Inference  | Groq — llama-3.1-8b-instant                 |
| Database   | Supabase — tjiiggmuqlaexzerrlyn             |
| Solana RPC | Helius devnet                               |
| Cache      | Redis (optional — falls back to in-memory)  |

## Supabase SQL migration (run once in dashboard SQL editor)

```sql
create table if not exists jobs (
  id text primary key,
  customer text,
  model text,
  sla_tier text,
  ttft_ms int,
  tpot_ms int,
  sla_met boolean,
  confidential boolean,
  worker text,
  worker_address text,
  ts float8,
  penalty_paid float8,
  fee float8,
  status text,
  attestation_hash text,
  created_at timestamptz default now()
);

create table if not exists workers (
  address text primary key,
  role text, endpoint text, sla_tiers text,
  tee_capable boolean, reliability_score int,
  goodput_score int, sla_pass_rate float8,
  p99_ttft_ms int, status text, staked_lock int,
  hardware_tier text, jobs_today int,
  earnings_today float8, penalties_paid int,
  is_confidential boolean, last_heartbeat float8,
  registered_at float8
);

alter table jobs    enable row level security;
alter table workers enable row level security;
```
