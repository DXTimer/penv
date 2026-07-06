#!/usr/bin/env bash
# seed.sh — Tier 1 fast-path: instant seeded clone via CREATE DATABASE … TEMPLATE
# Called by `penv up --seed` (after provision.sh).
# Uses Postgres template cloning — far faster than restoring a dump.
set -euo pipefail

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
PGPASSWORD="${PGPASSWORD:-}"
export PGPASSWORD

# The template DB must exist and have no active connections.
# Create it once (outside penv) with your seed data, then point PENV_SEED_TEMPLATE at it.
template="${PENV_SEED_TEMPLATE:-preview_seed_template}"
db=$(penv get name preview) # same idempotent call as provision.sh

# Verify template exists before proceeding
if ! psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" \
       -lqt | cut -d\| -f1 | grep -qw "$template"; then
  echo "penv seed: template DB '$template' not found — skipping seed" >&2
  echo "penv seed: create it with: createdb -T template1 $template && <load your data>" >&2
  exit 0
fi

# Terminate existing connections to the target so DROP DATABASE works
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$db'" \
  >/dev/null 2>&1 || true

# Drop + recreate from template (atomic, no pg_dump/pg_restore overhead)
dropdb  -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$db"              2>/dev/null || true
createdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -T "$template" "$db"

echo "penv seed: cloned $template → $db"
