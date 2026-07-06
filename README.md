# penv — Preview Environment Isolation

`penv` gives every [git worktree](https://git-scm.com/docs/git-worktree) its own **isolated preview environment** — a dedicated database, cache index, and set of ports. Spin up as many worktrees as you like; they never collide with each other and never touch your shared dev resources. On the main checkout, `penv` is a no-op.

It's repo-agnostic. A small **engine** owns the hard, universal parts — stable ids, collision-free allocation, an atomic ledger, `.env.preview` generation — and each repo supplies a handful of tiny **lifecycle scripts** in `.preview/` that say how to create, verify, and tear down its stack. `penv init` can generate them for you.

Built with [Bun](https://bun.sh). Pairs with its sibling [`wt`](https://github.com/DXTimer/wt), which runs `penv up` / `penv destroy` automatically on worktree create/remove.

## Features

- **Zero shared state** — every worktree gets its own database, cache index, and ports; nothing is shared with the main checkout or the worktree next door.
- **~1s provisioning** — clone a pre-migrated template with `CREATE DATABASE ... TEMPLATE` instead of running migrations in every worktree.
- **Collision-free allocation** — ports and indices come from a machine-local ledger; the *range = pool* model keeps every allocation distinct across all live envs.
- **Idempotent & rename-safe** — ids are anchored to the worktree path, so re-provisioning is a no-op and renaming a branch never orphans an env.
- **Self-healing schema** — a worktree applies any migrations newer than the template automatically; fold them back into the template when you like.
- **Flush-before-release teardown** — resources are dropped/flushed *before* their slots are freed, so a reused slot can't collide with a half-torn-down one.
- **Repo-agnostic** — the engine never guesses your stack; five small `.preview/*.sh` scripts do, and `penv doctor` scaffolds them.
- **Agent-ready** — `penv session` feeds a SessionStart hook so an assistant opening a worktree learns its isolated resources up front. Integrates with `wt`, Claude Code, and Codex.
- **Scriptable** — `--json` on every command, plus primitives (`penv get port|index|name`, `penv env`) you compose from your own scripts.

## Requirements

- [Bun](https://bun.sh)
- Git 2.22+ (worktree support)
- For Tier 1 isolation: a namespaceable service (Postgres, Redis, Kafka, Mongo…). Tier 0 (files + ports) needs nothing else.

## Install

```bash
git clone https://github.com/DXTimer/penv.git
cd penv
bun install
bash install/install.sh --from-source   # builds penv → ~/.local/bin and adds it to PATH
```

`install.sh` is **idempotent** — safe on a fresh or already-configured machine. It compiles a standalone binary, drops it in `~/.local/bin`, and adds that directory to your `PATH` via a single marked block in your shell rc, so re-running never duplicates setup.

Pre-built release binaries are planned; `--from-source` (which needs Bun) is the current path.

## Quick start

```bash
cd my-repo
penv doctor      # detect your stack + isolation tier (report only)
penv init        # generate .preview/*.sh + agent integration

# then, inside any worktree:
penv up          # provision this worktree's isolated env → writes .env.preview
penv verify      # assert it's reachable AND isolated
penv status      # show the allocation (db / indices / ports)
penv destroy     # tear it down and release the slots
```

`penv up` is what a worktree runs to come alive — and `wt` (below) can run it for you on create.

## Commands

**Primitives** — call these from your `.preview/*.sh`:

| Command | Description |
| --- | --- |
| `penv id` | Print the stable env id (empty on the main checkout). |
| `penv is-worktree` | Exit 0 in a linked worktree, 1 otherwise. |
| `penv get port <name> [a-b]` | Idempotent, collision-free port. |
| `penv get index <name> <a-b>` | Idempotent, collision-free integer (e.g. a redis db). *Range = pool*: names sharing a range stay mutually distinct across every env. |
| `penv get name <suffix>` | Namespaced name, e.g. `preview_<id>`. |
| `penv env [KEY=VAL ...]` | Atomically merge keys into `.env.preview` (also reads stdin). |

**Lifecycle:**

| Command | Description |
| --- | --- |
| `penv up [--seed] [--no-migrate]` | Run `.preview/provision.sh` (and `seed.sh` on `--seed`). |
| `penv verify` | Run `.preview/verify.sh` — reachable AND isolated. |
| `penv down` | Stop the stack, if `.preview/down.sh` exists. |
| `penv destroy [--force]` | Run `teardown.sh`, then release the slots. |
| `penv status` | This worktree's allocation record. |
| `penv session` | Emit preview context for a SessionStart hook; no-op on main. |
| `penv list` | Every live env on this machine. |

**Setup:** `penv doctor` (detect stack / tier / agents — report only) · `penv init` (generate `.preview/*` + agent integration).

Common flags: `--json`, `--verbose`/`-v`, `--force`/`-f`, `--seed`, `--no-migrate`, `--version`/`-V`, `--help`/`-h`.

## The `.preview/` contract

Each repo provides a few scripts. They receive a guaranteed input environment (`PENV_ID`, `PENV_ROOT`, `PENV_DIR`, `PENV_BRANCH`, `PENV_BIN`, `PENV_SEED`, `PENV_NO_MIGRATE`) and use the `penv get*` / `penv env` primitives to allocate and record resources.

| Script | Required | Runs on |
| --- | --- | --- |
| `provision.sh` | yes | `penv up` — create the isolated env, write `.env.preview`. |
| `verify.sh` | yes | `penv verify` — assert reachable AND isolated. |
| `teardown.sh` | yes | `penv destroy` — drop/flush resources before slot release. |
| `seed.sh` | optional | `penv up --seed` — load data. |
| `bootstrap.sh` | optional | one-time / on schema change — build a template DB. |
| `down.sh` | optional | `penv down` — stop a running stack. |

Teardown runs to completion **before** the ledger record is removed (flush-before-release), so a freed slot can't be reused mid-teardown.

See [`penv/CONTRACT.md`](penv/CONTRACT.md) for the full contract and copy-paste templates, and [`samples/preview/`](samples/preview/) for working Postgres+Redis, SQLite, and Mongo examples.

## Isolation tiers

`penv doctor` classifies a repo's stack so you know what's isolatable:

- **Tier 0** — file / SQLite state + ports. Isolate by data dir + port allocation.
- **Tier 1** — namespaceable services (Postgres, Redis, Kafka). Isolate by per-env database / index + ports. The common case.
- **Tier 2** — resources that can't be safely namespaced locally; flagged so you can decide how to handle them.

## With `wt`

`penv` is the runtime companion to [`wt`](https://github.com/DXTimer/wt), a git worktree provisioner. When both are installed, `penv init` wires them together: `wt` symlinks shared files and runs `penv up` in each new worktree, then `penv destroy` on removal. Used **without** `wt`, `penv` still does everything — you just run `penv up` / `penv destroy` yourself (or from your own worktree hooks). `penv init` detects which case you're in and scaffolds accordingly.

## Configuring with an AI agent

[`skills/preview-isolation/SKILL.md`](skills/preview-isolation/SKILL.md) is a ready-made skill for having an AI assistant detect your stack and generate the `.preview/*.sh` scripts for you.

## License

[MIT](LICENSE) © Ivan Bakalov

---

Built and maintained by [Ivan Bakalov](https://github.com/DXTimer).
