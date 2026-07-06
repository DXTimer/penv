#!/usr/bin/env bash
# teardown.sh — Tier 1: drop the per-env MongoDB database
# Called by `penv destroy`. Idempotent and defensive.
# Do NOT remove .env.preview here — the engine does that after this script exits.
set -euo pipefail

MONGO_HOST="${MONGO_HOST:-localhost}"
MONGO_PORT="${MONGO_PORT:-27017}"
MONGO_USER="${MONGO_USER:-}"
MONGO_PASSWORD="${MONGO_PASSWORD:-}"

# Source .env.preview to get the exact resource identifiers this env owns.
if [ -f "$PENV_ROOT/.env.preview" ]; then
  set -a; source "$PENV_ROOT/.env.preview"; set +a
fi

# Fall back to constructing from PENV_ID if the env file is already gone
db="${MONGO_DB:-preview_${PENV_ID}}"

# Build a URI to the admin DB for the dropDatabase command
if [ -n "$MONGO_USER" ] && [ -n "$MONGO_PASSWORD" ]; then
  admin_uri="mongodb://${MONGO_USER}:${MONGO_PASSWORD}@${MONGO_HOST}:${MONGO_PORT}/admin?authSource=admin"
else
  admin_uri="mongodb://${MONGO_HOST}:${MONGO_PORT}/admin"
fi

# Drop the per-env database (best-effort)
mongosh --quiet --eval "
  db = db.getSiblingDB('$db');
  db.dropDatabase();
  print('dropped');
" "$admin_uri" >/dev/null 2>&1 \
  && echo "penv: dropped MongoDB database $db" \
  || echo "penv: MongoDB drop of $db failed or already gone (ok)"

echo "penv: teardown done for $PENV_ID"
