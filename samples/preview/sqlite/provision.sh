#!/usr/bin/env bash
# provision.sh — Tier 0: per-env SQLite data dir + isolated app port
# Called by `penv up [--seed] [--no-migrate]`.
# Idempotent: re-running reuses the same directory and port.
set -euo pipefail

# Per-env data directory under .penv/<id>/ — gitignored, never shared.
data_dir="$PENV_ROOT/.penv/$PENV_ID"
app_port=$(penv get port app) # collision-free port in 20000–29999

# Create the data directory (idempotent)
mkdir -p "$data_dir"

# Write connection config atomically into .env.preview.
# `penv env` merges: re-running never duplicates keys.
penv env <<EOF
APP_DATA_DIR=$data_dir
APP_DB_PATH=$data_dir/app.sqlite
APP_PORT=$app_port
EOF

echo "penv: provision done — data=$data_dir port=$app_port"
