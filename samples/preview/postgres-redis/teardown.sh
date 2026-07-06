#!/usr/bin/env bash
# teardown.sh — Tier 1: terminate backends, drop DB, flush Redis index
# Called by `penv destroy`. Idempotent and defensive (|| true on best-effort drops).
# Do NOT remove .env.preview here — the engine does that after this script exits.
set -euo pipefail

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
PGPASSWORD="${PGPASSWORD:-}"
REDIS_HOST="${REDIS_HOST:-localhost}"
REDIS_PORT="${REDIS_PORT:-6379}"
export PGPASSWORD

# Source .env.preview to get the exact resource identifiers this env owns.
# Fall back to constructing names from PENV_ID if the file is already gone.
if [ -f "$PENV_ROOT/.env.preview" ]; then
  set -a; source "$PENV_ROOT/.env.preview"; set +a
fi

db="${DATABASE_URL##*/}"          # extract db name from URL
db="${db:-preview_${PENV_ID}}"    # fallback if URL was unset

# ── Postgres: terminate active connections, then drop ────────────────────────
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$db'" \
  >/dev/null 2>&1 || true

dropdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$db" 2>/dev/null \
  && echo "penv: dropped database $db" \
  || echo "penv: database $db already gone (ok)"

# ── Redis: flush the per-env index ───────────────────────────────────────────
# Extract the index from the stored REDIS_URL (e.g. redis://localhost:6379/7 → 7)
redis_idx=""
if [ -n "${REDIS_URL:-}" ]; then
  redis_idx="${REDIS_URL##*/}"
fi

# If we lost the env file, fall back to penv primitives
if [ -z "$redis_idx" ]; then
  redis_idx=$(penv get index redis 2-63 2>/dev/null || true)
fi

if [ -n "$redis_idx" ] && [ "$redis_idx" != "0" ] && [ "$redis_idx" != "1" ]; then
  redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -n "$redis_idx" flushdb >/dev/null 2>&1 \
    && echo "penv: flushed redis db $redis_idx" \
    || echo "penv: redis db $redis_idx flush failed (ok — may already be gone)"
fi

echo "penv: teardown done for $PENV_ID"
