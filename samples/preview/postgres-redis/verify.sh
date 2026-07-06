#!/usr/bin/env bash
# verify.sh — Tier 1: assert DB is isolated (not the shared dev DB) and reachable
# Exit 0 = green. Exit non-zero = something is wrong.
set -euo pipefail

if [ ! -f "$PENV_ROOT/.env.preview" ]; then
  echo "FAIL: .env.preview missing — run: penv up" >&2
  exit 1
fi

set -a; source "$PENV_ROOT/.env.preview"; set +a

# ── isolation checks ─────────────────────────────────────────────────────────

# 1. DATABASE_URL must end with the per-env db name
expected_db="preview_${PENV_ID}"
case "${DATABASE_URL:-}" in
  *"/$expected_db")
    ;;
  *)
    echo "FAIL: DATABASE_URL is not isolated — expected suffix /$expected_db, got: ${DATABASE_URL:-<unset>}" >&2
    exit 1
    ;;
esac

# 2. REDIS_URL must NOT use index 0 (shared default) or 1 (common staging)
case "${REDIS_URL:-}" in
  */0 | */1)
    echo "FAIL: REDIS_URL uses shared index ${REDIS_URL##*/} — must be 2-63" >&2
    exit 1
    ;;
  */[2-9] | */[1-5][0-9] | */6[0-3])
    # valid range 2-63
    ;;
  *)
    echo "FAIL: REDIS_URL missing or has unexpected index: ${REDIS_URL:-<unset>}" >&2
    exit 1
    ;;
esac

# 3. API_PORT must be set
[ -n "${API_PORT:-}" ] || { echo "FAIL: API_PORT not set in .env.preview" >&2; exit 1; }

# ── reachability check ───────────────────────────────────────────────────────
psql "$DATABASE_URL" -c 'SELECT 1' >/dev/null 2>&1 \
  || { echo "FAIL: database unreachable at $DATABASE_URL" >&2; exit 1; }

echo "ok: db=$expected_db redis_idx=${REDIS_URL##*/} api_port=$API_PORT"
