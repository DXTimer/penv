#!/usr/bin/env bash
# verify.sh — Tier 1: assert Mongo DB is isolated and reachable
# Exit 0 = green. Exit non-zero = something is wrong.
set -euo pipefail

if [ ! -f "$PENV_ROOT/.env.preview" ]; then
  echo "FAIL: .env.preview missing — run: penv up" >&2
  exit 1
fi

set -a; source "$PENV_ROOT/.env.preview"; set +a

# ── isolation checks ─────────────────────────────────────────────────────────

# 1. MONGO_DB must be the per-env namespaced name
expected_db="preview_${PENV_ID}"
if [ "${MONGO_DB:-}" != "$expected_db" ]; then
  echo "FAIL: MONGO_DB is not isolated — expected $expected_db, got: ${MONGO_DB:-<unset>}" >&2
  exit 1
fi

# 2. MONGO_URI must reference the per-env DB (not a shared default)
case "${MONGO_URI:-}" in
  *"/$expected_db"* | *"/$expected_db?*")
    ;;
  *)
    echo "FAIL: MONGO_URI does not reference $expected_db — got: ${MONGO_URI:-<unset>}" >&2
    exit 1
    ;;
esac

# 3. APP_PORT must be set
[ -n "${APP_PORT:-}" ] \
  || { echo "FAIL: APP_PORT not set in .env.preview" >&2; exit 1; }

# ── reachability check ───────────────────────────────────────────────────────
mongosh --quiet --eval "
  db = db.getSiblingDB('$MONGO_DB');
  db.runCommand({ ping: 1 });
  print('ping ok');
" "$MONGO_URI" >/dev/null 2>&1 \
  || { echo "FAIL: MongoDB unreachable at $MONGO_URI" >&2; exit 1; }

echo "ok: db=$MONGO_DB port=$APP_PORT"
