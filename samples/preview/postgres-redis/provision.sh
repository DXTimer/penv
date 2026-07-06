#!/usr/bin/env bash
# provision.sh — Tier 1: Postgres DB + Redis index + API port
# Called by `penv up [--seed] [--no-migrate]`.
# Idempotent: re-running reuses the same port/index/name.
set -euo pipefail

# ── host connection defaults (override via env) ──────────────────────────────
PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
PGPASSWORD="${PGPASSWORD:-}"
REDIS_HOST="${REDIS_HOST:-localhost}"
REDIS_PORT="${REDIS_PORT:-6379}"
export PGPASSWORD

# ── allocate per-env resources via penv primitives ───────────────────────────
# penv get is idempotent: the same id always returns the same value.
db=$(penv get name preview)            # e.g. preview_abc123
redis_idx=$(penv get index redis 2-63) # collision-free 2–63 (never 0 = prod, never 1 = staging)
api_port=$(penv get port api)          # collision-free 20000–29999

# ── create the Postgres database (no-op if already exists) ───────────────────
if createdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$db" 2>/dev/null; then
  echo "penv: created database $db"
else
  echo "penv: database $db already exists, reusing"
fi

# Add extensions your app requires (uncomment/edit as needed):
# psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$db" \
#   -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";' >/dev/null

# ── run migrations (skip when --no-migrate was passed) ───────────────────────
if [ "${PENV_NO_MIGRATE:-0}" != "1" ]; then
  # Replace with your actual migration command:
  # DATABASE_URL="postgresql://$PGUSER@$PGHOST:$PGPORT/$db" \
  #   your-migrate-command upgrade head
  echo "penv: migrations skipped (no migrate command configured — edit provision.sh)"
fi

# ── write .env.preview atomically via penv env ───────────────────────────────
# `penv env` merges; re-running never duplicates keys.
penv env <<EOF
DATABASE_URL=postgresql://$PGUSER@$PGHOST:$PGPORT/$db
REDIS_URL=redis://$REDIS_HOST:$REDIS_PORT/$redis_idx
API_PORT=$api_port
EOF

echo "penv: provision done — db=$db redis=$redis_idx port=$api_port"
