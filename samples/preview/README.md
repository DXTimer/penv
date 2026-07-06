# Preview environment samples

Each subdirectory is a self-contained, copy-paste-runnable set of lifecycle scripts
for one common stack tier. Copy the closest one into your repo's `.preview/` directory
and edit the commented sections.

## The four scripts

| Script | Required | Role |
|--------|----------|------|
| `provision.sh` | yes | Create isolated resources, write `.env.preview`. Idempotent. |
| `verify.sh` | yes | Assert isolated AND reachable. `penv verify` runs this. |
| `teardown.sh` | yes | Drop resources. Engine runs this before releasing slots. |
| `seed.sh` | optional | Load data. Engine runs this only when `penv up --seed` is used. |

All scripts must be `set -euo pipefail` and `chmod +x`.

## Contract summary

- **The engine** (`penv`) owns: stable ids, collision-free allocation, global locking, the ledger, teardown ordering.
- **Your scripts** own: creating the actual isolated resources (DB, data dir, etc.) and writing `.env.preview`.
- Call `penv get`/`penv env` from provision.sh — they are idempotent and recorded per env-id.
- `teardown.sh` must NOT remove `.env.preview` — the engine does that after your script exits.
- The engine guarantees teardown runs before slots are released; you do not need to think about flush-before-release ordering.

## Samples

| Directory | Tier | Stack | Use when |
|-----------|------|-------|----------|
| `postgres-redis/` | Tier 1 | PostgreSQL + Redis + port | Full-stack app with SQL DB and cache |
| `sqlite/` | Tier 0 | SQLite file + port | Lightweight app, file-based DB |
| `mongo/` | Tier 1 | MongoDB + port | Document-store app on shared mongod |

## Usage

```bash
# 1. Copy the closest sample
cp -r samples/preview/postgres-redis/ .preview/

# 2. Edit the commented sections (migration command, extensions, etc.)
# 3. Make scripts executable
chmod +x .preview/*.sh

# 4. Provision and verify
penv up
penv verify   # must be green before you declare done
```

## Guaranteed input vars

Every script receives these from the engine:

| Var | Value |
|-----|-------|
| `PENV_ID` | stable env id (safe for DB/dir/topic names) |
| `PENV_ROOT` | absolute worktree root |
| `PENV_DIR` | absolute path to `.preview/` |
| `PENV_BRANCH` | current branch |
| `PENV_SEED` | `1` when `penv up --seed` |
| `PENV_NO_MIGRATE` | `1` when `penv up --no-migrate` |
