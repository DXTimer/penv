#!/usr/bin/env bash
# verify.sh — Tier 0: assert data dir is per-env and port is set
# Exit 0 = green. Exit non-zero = something is wrong.
set -euo pipefail

if [ ! -f "$PENV_ROOT/.env.preview" ]; then
  echo "FAIL: .env.preview missing — run: penv up" >&2
  exit 1
fi

set -a; source "$PENV_ROOT/.env.preview"; set +a

# ── isolation checks ─────────────────────────────────────────────────────────

# 1. APP_DATA_DIR must be the per-env subdirectory (not the shared default)
expected_dir="$PENV_ROOT/.penv/$PENV_ID"
case "${APP_DATA_DIR:-}" in
  "$expected_dir")
    ;;
  *)
    echo "FAIL: APP_DATA_DIR is not isolated — expected $expected_dir, got: ${APP_DATA_DIR:-<unset>}" >&2
    exit 1
    ;;
esac

# 2. The data dir must actually exist on disk
[ -d "$APP_DATA_DIR" ] \
  || { echo "FAIL: data dir $APP_DATA_DIR does not exist — run: penv up" >&2; exit 1; }

# 3. APP_PORT must be set (non-empty)
[ -n "${APP_PORT:-}" ] \
  || { echo "FAIL: APP_PORT not set in .env.preview" >&2; exit 1; }

# ── optional reachability check ───────────────────────────────────────────────
# Uncomment and adapt to boot your server, probe it, then stop it:
#
# (APP_DATA_DIR="$APP_DATA_DIR" node server.js --port "$APP_PORT" &)
# server_pid=$!
# sleep 1
# curl -fsS "http://127.0.0.1:$APP_PORT/health" >/dev/null \
#   || { kill "$server_pid" 2>/dev/null; echo "FAIL: server did not respond on $APP_PORT" >&2; exit 1; }
# kill "$server_pid" 2>/dev/null || true

echo "ok: data=$APP_DATA_DIR port=$APP_PORT"
