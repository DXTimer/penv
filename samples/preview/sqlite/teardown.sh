#!/usr/bin/env bash
# teardown.sh — Tier 0: remove the per-env data directory
# Called by `penv destroy`. Idempotent.
# Do NOT remove .env.preview here — the engine does that after this script exits.
set -euo pipefail

# Source .env.preview to get the exact data dir this env owns.
if [ -f "$PENV_ROOT/.env.preview" ]; then
  set -a; source "$PENV_ROOT/.env.preview"; set +a
fi

# Fall back to the canonical path if the env file is already gone
data_dir="${APP_DATA_DIR:-$PENV_ROOT/.penv/$PENV_ID}"

if [ -d "$data_dir" ]; then
  rm -rf "$data_dir"
  echo "penv: removed data dir $data_dir"
else
  echo "penv: data dir $data_dir already gone (ok)"
fi

echo "penv: teardown done for $PENV_ID"
