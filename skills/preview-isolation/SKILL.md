---
name: preview-isolation
description: >
  Wire penv (collision-safe per-worktree preview environments) into a repository
  and prove it works. Use this skill whenever asked to: set up preview environments,
  isolate worktrees, add penv support, make preview envs collision-safe, prevent
  port/DB conflicts between branches, or configure per-worktree resource isolation.
---

# preview-isolation

Wire `penv` into a repository so every git worktree gets its own isolated
Postgres DB, Redis index, port, data dir — whatever the stack needs — with
zero manual coordination.

## Primitive contract

```
penv id                       # stable env id (empty on main — a true no-op)
penv is-worktree              # exit 0 in a linked worktree, 1 otherwise
penv get port  <name> [a-b]   # idempotent, collision-free port (default 20000–29999)
penv get index <name> <a-b>   # idempotent, collision-free integer (redis db, etc.)
penv get name  <suffix>       # namespaced name → preview_<id>
penv env <<EOF ... EOF        # atomic merge into .env.preview
```

`penv get` is idempotent and recorded: re-running `provision.sh` reuses the
same port/index/name. A machine-global lock prevents two worktrees from
colliding on simultaneous provision.

## Lifecycle

```
penv up [--seed] [--no-migrate]   → provision.sh (+ seed.sh if --seed)
penv verify                       → verify.sh
penv down                         → down.sh (if present)
penv destroy [--force]            → teardown.sh, then release slots
penv status / list                → show allocations
penv doctor                       → detect stack/tier, suggest sample
```

The engine runs `teardown.sh` BEFORE releasing slots — flush-before-release
is structural; scripts do not need to think about it.

## The four scripts (per-repo artifacts, live in `.preview/`)

| Script | Required | Purpose |
|--------|----------|---------|
| `provision.sh` | yes | Allocate resources, write `.env.preview`. Idempotent. |
| `verify.sh` | yes | Assert isolated AND reachable. The loop target. |
| `teardown.sh` | yes | Drop resources. Do NOT remove `.env.preview`. |
| `seed.sh` | optional | Load data. Only runs on `penv up --seed`. |

All scripts: `set -euo pipefail`, `chmod +x`, cwd = `PENV_ROOT`.

## The core method: write → `penv verify` → fix → green

This loop IS the setup. Do not declare done until `penv verify` exits 0.

```bash
# In the target worktree:
penv doctor                  # detect tier, confirm stack present
cp -r <closest-sample>/ .preview/
chmod +x .preview/*.sh
# edit provision.sh (migration cmd, extensions, etc.)
penv up
penv verify                  # fix until green
```

Run `penv doctor` first — it reports which tier fits and whether the required
tools (psql, redis-cli, mongosh, etc.) are on PATH.

Adapt the closest sample from `samples/preview/`:
- Postgres + Redis → `postgres-redis/`
- SQLite / file-based → `sqlite/`
- MongoDB → `mongo/`

Never cold-write scripts. Always adapt a sample.

## Scenario checklist — verify ALL before declaring done

Run each scenario in order. Every check must pass.

### 1. Branch rename → id unchanged, no orphan

```bash
# From inside a provisioned worktree:
original_id=$(penv id)
git branch -m new-branch-name
new_id=$(penv id)
[ "$original_id" = "$new_id" ] && echo "PASS: id stable" || echo "FAIL: id changed"
penv list   # no orphaned record for the old branch name
```

### 2. Two envs concurrent → distinct ports/indexes, no collision

```bash
# In worktree A (already provisioned):
port_a=$(grep APP_PORT .env.preview | cut -d= -f2)
idx_a=$(grep REDIS_URL .env.preview | grep -oE '/[0-9]+$' | tr -d '/')

# In worktree B (separate terminal, different branch):
penv up
port_b=$(grep APP_PORT .env.preview | cut -d= -f2)
idx_b=$(grep REDIS_URL .env.preview | grep -oE '/[0-9]+$' | tr -d '/')

[ "$port_a" != "$port_b" ] && echo "PASS: ports distinct" || echo "FAIL: port collision"
[ "$idx_a"  != "$idx_b"  ] && echo "PASS: redis idx distinct" || echo "FAIL: redis idx collision"
```

### 3. Teardown → zero residue

```bash
id=$(penv id)
penv destroy --force
# Ledger record gone:
penv list | grep "$id" && echo "FAIL: ledger record remains" || echo "PASS: record gone"
# .env.preview gone:
[ ! -f .env.preview ] && echo "PASS: .env.preview removed" || echo "FAIL: .env.preview remains"
# DB dropped (Postgres example):
psql -U postgres -lqt | grep "preview_$id" && echo "FAIL: DB remains" || echo "PASS: DB dropped"
```

### 4. On main → `penv up` / `id` are true no-ops

```bash
# From the main checkout (not a linked worktree):
penv is-worktree && echo "FAIL: main is not a worktree" || echo "PASS: not a worktree"
id=$(penv id)
[ -z "$id" ] && echo "PASS: id empty on main" || echo "FAIL: id non-empty on main: $id"
penv up 2>&1 | grep -qi "no.op\|not a worktree\|skip" && echo "PASS: up is no-op" || echo "NOTE: check penv up output manually"
```

### 5. Env A ↮ env B data isolation

```bash
# In worktree A (Postgres example):
psql "$DATABASE_URL" -c "CREATE TABLE _isolation_test (v text);"
psql "$DATABASE_URL" -c "INSERT INTO _isolation_test VALUES ('from-A');"

# In worktree B (separate terminal):
psql "$DATABASE_URL" -c "SELECT * FROM _isolation_test;" 2>&1 \
  | grep -q "from-A" && echo "FAIL: data leaked" || echo "PASS: isolated"

# Clean up env A:
psql "$DATABASE_URL" -c "DROP TABLE _isolation_test;" 2>/dev/null || true
```

## Worked example — SQLite sample adapted to a Node app

**Repo:** Express API, SQLite DB at `./data/app.db`, port from `APP_PORT` env var.

```bash
# 1. Copy sample
cp -r samples/preview/sqlite/ .preview/
chmod +x .preview/*.sh

# 2. provision.sh — no changes needed for pure SQLite + port
# Already writes APP_DATA_DIR, APP_DB_PATH, APP_PORT to .env.preview.

# 3. verify.sh — add the reachability check (uncomment the server block)
# Uncomment and edit:
#   (APP_DB_PATH="$APP_DB_PATH" node src/index.js &)
#   server_pid=$!
#   sleep 1
#   curl -fsS "http://127.0.0.1:$APP_PORT/healthz" >/dev/null \
#     || { kill "$server_pid"; echo "FAIL: server did not respond"; exit 1; }
#   kill "$server_pid"

# 4. seed.sh — set PENV_SEED_DB or drop a scripts/seed.sqlite into the repo
# No code changes needed — the sample already handles it.

# 5. gitignore the per-env data dirs
echo '.penv/' >> .gitignore

# 6. Provision and verify
penv up
penv verify   # must be green
```

Then run all five checklist scenarios above.
