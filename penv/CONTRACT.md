# penv lifecycle-script contract

`penv` (the engine) owns the hard, universal parts — stable ids, collision-free
allocation, locking, the ledger, teardown ordering. The **lifecycle scripts**
in a repo's `.preview/` directory own the easy, repo-specific parts — creating
the actual isolated resources. This file is the exact contract between them.

The engine never generates these at runtime; they are committed per-repo and
adapted by hand (or by `penv init`). An agent adapts the closest sample; it
never cold-writes.

## Primitive CLI (call these from the scripts)

```
penv id                       # stable env id for this worktree (empty on main)
penv is-worktree              # exit 0 in a linked worktree, 1 otherwise
penv get port  <name> [a-b]   # idempotent, collision-free port (default 20000-29999)
penv get index <name> <a-b>   # idempotent, collision-free integer (e.g. redis db 2-63)
penv get name  <suffix>       # namespaced name, e.g. `preview` -> preview_<id>
penv env [KEY=VAL ...]        # atomic merge into <root>/.env.preview (also reads stdin heredoc)
```

`get` is idempotent and recorded under the current id: re-running `provision.sh`
reuses the same port/index/name, and the engine knows the exact set to release
on `penv destroy`. Allocation is serialized by a machine-global lock, so two
worktrees provisioning at once never collide.

## Guaranteed input environment (set by the engine for every script)

| Var          | Meaning                                              |
| ------------ | ---------------------------------------------------- |
| `PENV_ID`    | stable env id (safe for DB/dir/topic names)          |
| `PENV_ROOT`  | absolute worktree root (git toplevel)                |
| `PENV_DIR`   | absolute path to the `.preview` dir                  |
| `PENV_BRANCH`| current branch (may be empty on detached HEAD)       |
| `PENV_BIN`   | how to re-invoke penv (prefer `penv` on PATH)        |
| `PENV_SEED`  | `1` when `penv up --seed` was used (provision/seed)  |
| `PENV_NO_MIGRATE` | `1` when `--no-migrate` was used                |

The rest of the host environment passes through unchanged. Host connection
defaults (`PGHOST`, `PGPORT`, `PGUSER`, `REDIS_HOST`, …) are repo-specific —
read them directly, with sensible fallbacks.

## The four scripts

cwd for every script is `PENV_ROOT`. All must be `set -euo pipefail`.

### `provision.sh` (required)
Create this env's isolated resources and write `.env.preview`. Idempotent —
safe to re-run. Exit non-zero on failure (engine aborts and reports).

### `seed.sh` (optional)
Load data. Only run by `penv up --seed`. Skill teaches engine-specific fast
paths (Postgres `CREATE DATABASE … TEMPLATE` for an instant seeded clone,
SQLite file copy, etc.).

### `verify.sh` (required)
Assert the env is **reachable AND isolated** — not pointing at the shared
default DB / index / port / data dir. Exit 0 = green. This is the script the
write→verify→green loop runs.

### `teardown.sh` (required)
Drop *this env's* resources (DB, redis index flush, data dir). Idempotent and
defensive (`|| true` on best-effort drops). The engine runs this BEFORE it
releases the env's slots — so the flush-before-release invariant is structural,
you don't have to think about it. Do NOT remove `.env.preview` or the ledger
record; the engine does that.

## Run mechanism

Detected, not imposed: a Procfile, compose service, `dev` script, or framework
server. There is no Overmind requirement. For a self-contained proof, `verify.sh`
may itself boot the service on the allocated port, probe it, and stop it.

---

## Canonical templates

### Tier 0 — file/stateless (SQLite + ports), e.g. a Node app keyed on a data dir + port

`provision.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail
id="$PENV_ID"
data="$PENV_ROOT/.penv/$id"          # per-env data dir (gitignored)
port=$(penv get port app)
mkdir -p "$data"
penv env <<EOF
APP_DATA_DIR=$data
APP_PORT=$port
EOF
```

`verify.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail
set -a; source "$PENV_ROOT/.env.preview"; set +a
# isolated: data dir is per-env, port is not the shared default
case "$APP_DATA_DIR" in "$PENV_ROOT/.penv/$PENV_ID") ;; *) echo "FAIL: data dir not isolated"; exit 1;; esac
[ -n "${APP_PORT:-}" ] || { echo "FAIL: no port"; exit 1; }
# reachable: boot, probe, stop (adjust start command to the repo)
# (node server.js &) ; sleep 1 ; curl -fsS "http://127.0.0.1:$APP_PORT/health" ; kill %1
echo "ok: port=$APP_PORT data=$APP_DATA_DIR"
```

`teardown.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail
if [ -f "$PENV_ROOT/.env.preview" ]; then set -a; source "$PENV_ROOT/.env.preview"; set +a; fi
rm -rf "${APP_DATA_DIR:-$PENV_ROOT/.penv/$PENV_ID}"
```

### Tier 1 — namespaceable shared service (Postgres + Redis)

`provision.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail
id="$PENV_ID"
PGHOST="${PGHOST:-localhost}"; PGPORT="${PGPORT:-5432}"; PGUSER="${PGUSER:-postgres}"
db="preview_${id}"
redis_idx=$(penv get index redis 2-63)
api=$(penv get port api)

createdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$db" 2>/dev/null || true
# extensions/migrations are lines you write because you read the repo:
# psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$db" -c 'CREATE EXTENSION IF NOT EXISTS vector;'
# [ "$PENV_NO_MIGRATE" = 1 ] || (cd apps/backend && alembic upgrade head)

penv env <<EOF
DATABASE_URL=postgresql://$PGUSER@$PGHOST:$PGPORT/$db
REDIS_URL=redis://${REDIS_HOST:-localhost}:${REDIS_PORT:-6379}/$redis_idx
API_PORT=$api
EOF
```

`seed.sh` (fast path: instant seeded clone from a template DB)
```bash
#!/usr/bin/env bash
set -euo pipefail
PGHOST="${PGHOST:-localhost}"; PGPORT="${PGPORT:-5432}"; PGUSER="${PGUSER:-postgres}"
db="preview_${PENV_ID}"; template="${PENV_SEED_TEMPLATE:-preview_seed_template}"
# DROP + CREATE ... TEMPLATE is far faster than restoring a dump.
dropdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$db" 2>/dev/null || true
createdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -T "$template" "$db"
```

`verify.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail
set -a; source "$PENV_ROOT/.env.preview"; set +a
# isolated: not the shared dev DB / redis db 0
case "$DATABASE_URL" in *"/preview_${PENV_ID}") ;; *) echo "FAIL: DB not isolated"; exit 1;; esac
case "$REDIS_URL" in */0) echo "FAIL: redis on shared db 0"; exit 1;; esac
# reachable
psql "$DATABASE_URL" -c 'SELECT 1' >/dev/null || { echo "FAIL: db unreachable"; exit 1; }
echo "ok: $DATABASE_URL  $REDIS_URL"
```

`teardown.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail
PGHOST="${PGHOST:-localhost}"; PGPORT="${PGPORT:-5432}"; PGUSER="${PGUSER:-postgres}"
db="preview_${PENV_ID}"
# terminate stragglers, then drop
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$db'" >/dev/null 2>&1 || true
dropdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$db" 2>/dev/null || true
# redis index flush (engine guarantees this runs before the slot is released)
if [ -f "$PENV_ROOT/.env.preview" ]; then
  set -a; . "$PENV_ROOT/.env.preview"; set +a
  idx="${REDIS_URL##*/}"   # index = last path segment of the redis URL (portable; no GNU sed)
  [ -n "$idx" ] && redis-cli -h "${REDIS_HOST:-localhost}" -p "${REDIS_PORT:-6379}" -n "$idx" flushdb >/dev/null 2>&1 || true
fi
```
