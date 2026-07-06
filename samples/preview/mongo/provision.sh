#!/usr/bin/env bash
# provision.sh — Tier 1: MongoDB namespaced DB + app port
# Called by `penv up [--seed] [--no-migrate]`.
# Idempotent: MongoDB creates the DB on first write; re-running is safe.
set -euo pipefail

MONGO_HOST="${MONGO_HOST:-localhost}"
MONGO_PORT="${MONGO_PORT:-27017}"
# If your mongod requires auth, set MONGO_USER / MONGO_PASSWORD in the host env.
MONGO_USER="${MONGO_USER:-}"
MONGO_PASSWORD="${MONGO_PASSWORD:-}"

# ── allocate per-env resources ────────────────────────────────────────────────
db=$(penv get name preview)   # e.g. preview_abc123
app_port=$(penv get port app) # collision-free port in 20000–29999

# Build the connection URI
if [ -n "$MONGO_USER" ] && [ -n "$MONGO_PASSWORD" ]; then
  mongo_uri="mongodb://${MONGO_USER}:${MONGO_PASSWORD}@${MONGO_HOST}:${MONGO_PORT}/${db}?authSource=admin"
else
  mongo_uri="mongodb://${MONGO_HOST}:${MONGO_PORT}/${db}"
fi

# MongoDB creates the DB lazily on first write; create a sentinel collection now
# so the DB shows up in listDatabases and teardown can target it reliably.
mongosh --quiet --eval "
  db = db.getSiblingDB('$db');
  db.createCollection('_penv_sentinel');
  print('ok');
" "$mongo_uri" >/dev/null 2>&1 || {
  echo "penv: warning — mongosh ping failed (DB will be created on first app write)" >&2
}

# ── write .env.preview atomically ────────────────────────────────────────────
penv env <<EOF
MONGO_URI=$mongo_uri
MONGO_DB=$db
APP_PORT=$app_port
EOF

echo "penv: provision done — db=$db port=$app_port"
