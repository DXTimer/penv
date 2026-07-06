#!/usr/bin/env bash
# seed.sh — Tier 0 fast-path: copy a seed SQLite file into the per-env data dir
# Called by `penv up --seed` (after provision.sh).
set -euo pipefail

if [ ! -f "$PENV_ROOT/.env.preview" ]; then
  echo "penv seed: .env.preview missing — run: penv up first" >&2
  exit 1
fi
set -a; source "$PENV_ROOT/.env.preview"; set +a

# PENV_SEED_DB: path to the seed SQLite file (relative to repo root or absolute).
# Defaults to scripts/seed.sqlite. Override in your shell or CI before running.
seed_file="${PENV_SEED_DB:-$PENV_ROOT/scripts/seed.sqlite}"

if [ ! -f "$seed_file" ]; then
  echo "penv seed: seed file not found at $seed_file — skipping" >&2
  echo "penv seed: create one with: sqlite3 scripts/seed.sqlite < scripts/seed.sql" >&2
  exit 0
fi

# Copy seed file to the per-env location (overwrite if re-seeding)
cp "$seed_file" "$APP_DB_PATH"
echo "penv seed: copied $seed_file → $APP_DB_PATH"
