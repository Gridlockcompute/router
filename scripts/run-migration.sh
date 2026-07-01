#!/usr/bin/env bash
# Run a SQL migration against Supabase Postgres via psql.
#
# You need the Postgres URI from whoever owns the Supabase project:
#   Dashboard → Project Settings → Database → Connection string (URI)
#
# Set it once (do NOT commit this):
#   export DATABASE_URL='postgresql://postgres.[ref]:[PASSWORD]@aws-0-[region].pooler.supabase.com:6543/postgres'
#
# Or add to gridlock-backend/.env (backend ignores DATABASE_URL at runtime):
#   DATABASE_URL=postgresql://...
#
# Usage:
#   cd gridlock-backend
#   ./scripts/run-migration.sh migrations/008_worker_payouts.sql

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SQL_FILE="${1:-}"

if [[ -z "$SQL_FILE" ]]; then
  echo "Usage: $0 <path-to.sql>" >&2
  echo "Example: $0 migrations/008_worker_payouts.sql" >&2
  exit 1
fi

if [[ ! -f "$ROOT/$SQL_FILE" && ! -f "$SQL_FILE" ]]; then
  echo "File not found: $SQL_FILE" >&2
  exit 1
fi

TARGET="$SQL_FILE"
if [[ -f "$ROOT/$SQL_FILE" ]]; then
  TARGET="$ROOT/$SQL_FILE"
fi

# Load DATABASE_URL from .env if not already exported
if [[ -z "${DATABASE_URL:-}" && -f "$ROOT/.env" ]]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ROOT/.env" | head -1 | cut -d= -f2- | tr -d '\r' || true)"
  export DATABASE_URL
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set." >&2
  echo "Ask the Supabase owner for the Postgres connection string, then either:" >&2
  echo "  export DATABASE_URL='postgresql://...'" >&2
  echo "  or add DATABASE_URL=... to gridlock-backend/.env" >&2
  exit 1
fi

echo "Running $TARGET …"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$TARGET"
echo "Done."
