# router

Gridlock **Router** — the central API service for the [Gridlock](https://grid-lock.tech) decentralized AI inference network. Built with **Hono** on Node.js, it exposes an OpenAI-compatible chat API, routes jobs to GPU workers over WebSocket, caches KV prefixes in **Redis**, persists state in **Supabase**, and optionally settles jobs on **Solana** via Anchor programs.

**Production:** [https://api.grid-lock.tech](https://api.grid-lock.tech)

## What it is

The router is the coordination layer between customers and worker operators:

1. **Customers** send `POST /v1/chat/completions` with an API key (OpenAI-compatible format + Gridlock SLA extensions)
2. **Router** authenticates, checks billing credits, picks a worker (Prefill/Decode roles), and dispatches via WebSocket
3. **Workers** ([worker-desktop](https://github.com/Gridlockcompute/worker-desktop), [worker-cli](https://github.com/Gridlockcompute/worker-cli)) run inference locally (Ollama/vLLM) and return TTFT/TPOT metrics
4. **Settlement** records SLA compliance, applies penalties, and optionally submits on-chain transactions through [programs](https://github.com/Gridlockcompute/programs)

Workers connect at `wss://api.grid-lock.tech/v1/ws`. The web dashboard at [https://grid-lock.tech](https://grid-lock.tech) consumes the same API for Console, Explorer, Staking, and Worker views.

## Features

- **OpenAI-compatible API** — `/v1/chat/completions` with streaming (SSE)
- **WebSocket job hub** — real-time dispatch to desktop, native, and browser workers
- **Four SLA tiers** — `realtime`, `standard`, `batch`, `confidential` with TTFT/TPOT targets and penalty multipliers
- **Prefill/Decode routing** — disaggregated worker roles with Redis KV warm-path
- **Worker registry** — public register/heartbeat endpoints; AutoGate after 120s silence
- **Wallet-owned API keys** — create, list, revoke via signed messages; hashed in Supabase
- **Off-chain billing** — per-wallet $LOCK credits, usage metering, monthly invoices, on-chain deposit confirmation
- **Passive staking** — stake info, deposit/unstake flows integrated with FeeCollector program
- **Solana settlement** — optional on-chain job escrow, receipt commit, fee distribution
- **Live stream** — SSE at `/v1/live` for job events
- **Redis cache** — prefix cache with in-memory fallback when Redis is unavailable

## Prerequisites

- **Node.js** 20+
- **Redis** 7+ (optional — falls back to in-memory cache)
- **Supabase** project (optional — local seed data when unset; required for API keys and billing)
- **Solana CLI keypair** (optional — only when `SOLANA_SETTLEMENT_ENABLED=true`)
- Deployed [Anchor programs](https://github.com/Gridlockcompute/programs) and LOCK vault addresses (optional — for on-chain mode)

## Installation

```bash
git clone https://github.com/Gridlockcompute/router.git
cd router
cp .env.example .env
# Edit .env — see Configuration below
npm install
npm run dev
```

Default listen port: **8080** (override with `PORT`).

Health check:

```bash
curl http://127.0.0.1:8080/health
```

Production:

```bash
curl https://api.grid-lock.tech/health
```

## Configuration

Copy [`.env.example`](./.env.example) to `.env`. Key sections:

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP listen port |

### Inference fallback

Used when no live WebSocket worker handles a job:

| Variable | Default | Description |
|----------|---------|-------------|
| `VLLM_ENDPOINT` | `http://127.0.0.1:8000/v1` | OpenAI-compatible inference endpoint (local dev) |
| `VLLM_API_KEY` | — | Bearer token for the inference endpoint |

### Cache

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection (local dev) |

### Solana

| Variable | Default | Description |
|----------|---------|-------------|
| `SOLANA_RPC_URL` | devnet RPC | Solana JSON-RPC endpoint |
| `SOLANA_CLUSTER` | `devnet` | Explorer cluster (`devnet` \| `mainnet-beta`) |
| `ROUTER_KEYPAIR_PATH` | `~/.config/solana/id.json` | Router signing keypair |
| `SOLANA_SETTLEMENT_ENABLED` | `false` | Enable on-chain job settlement |
| `LOCK_MINT` | — | LOCK Token-2022 mint |
| `FEE_VAULT`, `STAKER_POOL`, `WORKER_PAYOUT`, `TREASURY`, `BURN_VAULT` | — | Fee vault addresses |
| `CUSTOMER_WALLET` | — | Router LOCK ATA for job escrow |
| `DEFAULT_WORKER_STAKE` | — | Default worker penalty stake ATA |

Program IDs (devnet) are hardcoded in `src/config.ts` — see [programs repo](https://github.com/Gridlockcompute/programs).

### Supabase

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable key (if used by clients) |
| `SUPABASE_KEY` | Service role key |

Run SQL migrations in order from `migrations/` (`001_initial.sql` through `007_stake.sql`).

### Auth and billing

| Variable | Default | Description |
|----------|---------|-------------|
| `API_KEYS` | — | Comma-separated bootstrap API keys |
| `GRIDLOCK_INSECURE_KEY_MANAGEMENT` | `false` | Dev: trust `X-Gridlock-Wallet` without signature |
| `GRIDLOCK_BILLING_ENABLED` | `true` | Deduct off-chain $LOCK credits on chat |
| `GRIDLOCK_STARTING_CREDIT_LOCK` | `10` | Credits for new wallets |
| `GRIDLOCK_BILLING_DEV_TOPUP` | `true` | Dev: enable test top-up endpoint |
| `GRIDLOCK_MIN_DEPOSIT_LOCK` | `1` | Minimum on-chain deposit |
| `GRIDLOCK_STAKING_ENABLED` | `true` | Passive staking endpoints |
| `GRIDLOCK_MIN_STAKE_LOCK` | `1` | Minimum stake amount |
| `GRIDLOCK_INVOICE_CRON` | `true` | Auto-generate monthly invoices |
| `WATCHER_SAMPLE_RATE` | `0.05` | SLA watcher sampling rate |

See `.env.example` for the full list with comments.

## Usage examples

### Chat completions

```bash
curl https://api.grid-lock.tech/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer gk_your_api_key" \
  -d '{
    "model": "llama3.1:8b",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": false,
    "gridlock": {"sla": "standard", "privacy": false}
  }'
```

**SLA tiers:**

| Tier | TTFT target | TPOT target | Penalty multiplier |
|------|-------------|-------------|-------------------|
| `realtime` | 300 ms | 60 ms | 2× |
| `standard` | 800 ms | 120 ms | 1× |
| `batch` | 5000 ms | — | 0.25× |
| `confidential` | 800 ms | 120 ms | 1× (+ attestation) |

### Register a worker

```bash
curl -X POST https://api.grid-lock.tech/v1/workers/register \
  -H "Content-Type: application/json" \
  -d '{
    "operator_pubkey": "YourSolanaWalletAddress",
    "role": "Prefill",
    "hardware_tier": "RTX 4090",
    "tee_capable": false,
    "endpoint": "native://rtx-4090"
  }'
```

Workers maintain liveness via `POST /v1/workers/heartbeat` and WebSocket at `/v1/ws`.

### Wallet console session

```bash
# One-time wallet signature → 24h session token for billing/keys reads
curl -X POST https://api.grid-lock.tech/v1/auth/session \
  -H "Content-Type: application/json" \
  -d '{"wallet": "...", "signature": "...", "message": "..."}'
```

## Development

```bash
npm run dev          # tsx watch src/index.ts
npm run build        # tsc → dist/
npm start            # node dist/index.js
npm run test:api     # integration tests (server must be running)
```

### Docker

```bash
docker build -t gridlock-router .
docker run -p 8080:8080 --env-file .env gridlock-router
```

### Project layout

```
router/
├── src/
│   ├── index.ts           # Hono app bootstrap
│   ├── config.ts          # Env + program IDs + fee tables
│   ├── routes/            # chat, workers, jobs, billing, stake, keys, auth
│   ├── ws/                # WebSocket hub
│   ├── billing/           # credits, invoices, deposits
│   ├── staking/           # deposit, unstake, reads
│   └── solana-settlement.ts
├── migrations/            # Supabase SQL
├── test/
├── preset/setup.md        # Example dev preset
├── Dockerfile
└── .env.example
```

### Public endpoints (no API key)

`/health`, `/v1/live`, `/v1/ws`, `/v1/network/stats`, `/v1/capacity/tee`, `/v1/models`, `/v1/stake/info`, `/v1/stake/position`, `/v1/stake/deposit/info`, `/v1/chat/completions`, worker register/heartbeat/list.

Chat requires an API key when keys exist in Supabase or `API_KEYS` is set.

## Architecture

```
Customer / Console
        │  POST /v1/chat/completions
        ▼
┌───────────────────────────────┐
│      Gridlock Router          │
│  Hono + WebSocket hub         │
│  Redis KV · Supabase · Solana │
└───────────────────────────────┘
        │  WS job:new
        ▼
   Worker clients (Ollama / vLLM)
   worker-desktop · worker-cli
```

## Related repos

| Repo | Role |
|------|------|
| [programs](https://github.com/Gridlockcompute/programs) | Solana Anchor programs — escrow, SLA, fees |
| [worker-desktop](https://github.com/Gridlockcompute/worker-desktop) | Electron GPU worker |
| [worker-cli](https://github.com/Gridlockcompute/worker-cli) | Headless CLI worker |

**Website:** [https://grid-lock.tech](https://grid-lock.tech) · **API reference:** [https://grid-lock.tech/docs](https://grid-lock.tech/docs)

## License

Private — see repository settings.
