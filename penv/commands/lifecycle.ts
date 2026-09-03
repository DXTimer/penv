import { existsSync, rmSync } from 'fs';
import { resolveId } from '../lib/id.ts';
import { withLock } from '../lib/lock.ts';
import { removeRecord, readRecord } from '../lib/ledger.ts';
import { mainRootFromCommonDir } from '../lib/git.ts';
import { runScript } from '../lib/exec.ts';
import { hasScript, scriptPath, contractEnv, previewDir } from '../lib/scripts.ts';
import { envFilePath } from '../lib/envfile.ts';
import { emit, say, note, fail, type Ctx } from '../lib/output.ts';

/**
 * `penv session` — the lightweight session-start setup. Designed to be wired to
 * a Claude Code SessionStart hook: its stdout is injected into the agent's
 * context so a session opened in a worktree learns its isolated DB/index/ports
 * up front. Silent no-op on the main checkout / outside a penv repo — "if it's
 * not a driven environment, nothing happens". Does NOT provision (cheap); the
 * agent finalizes with `penv up` when it actually needs the stack.
 */
export function cmdSession(ctx: Ctx): void {
  const { id, ctx: gc } = resolveId();
  let block = '';
  if (id && gc.root && hasScript(gc.root, 'provision.sh')) {
    const ef = envFilePath(gc.root);
    const rec = readRecord(id);
    const out: string[] = [
      '## Worktree preview environment (penv)',
      '',
      'This session runs in a git worktree with its own ISOLATED preview environment',
      '(dedicated database / cache index / ports). Use it — never the shared dev resources.',
      '',
    ];
    if (existsSync(ef) && rec) {
      out.push(`- env id: \`${id}\``);
      if (Object.keys(rec.ports).length) {
        out.push(`- ports: ${Object.entries(rec.ports).map(([k, v]) => `${k}=${v}`).join(', ')}`);
      }
      if (Object.keys(rec.indexes).length) {
        out.push(`- indexes: ${Object.entries(rec.indexes).map(([k, v]) => `${k}=${v}`).join(', ')}`);
      }
      out.push(`- connection details live in \`${ef}\` — source it for ad-hoc commands (psql, redis-cli, the app).`);
    } else {
      out.push(`- NOT provisioned yet — run \`penv up\` to create the isolated DB/index/ports (writes \`${ef}\`).`);
    }
    out.push('');
    out.push('Commands: `penv status` (live state) · `penv up` (provision) · `penv verify` (reachable + isolated) · `penv destroy` (teardown).');
    block = out.join('\n');
  }

  // --json: Codex SessionStart hook reads JSON on stdout; additionalContext is
  // injected into the model's context (mirrors Claude Code). Empty object on main.
  if (ctx.json) {
    console.log(
      block
        ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: block } })
        : '{}',
    );
    return;
  }
  // Raw markdown for the Claude Code SessionStart hook (stdout injected directly).
  if (block) console.log(block);
}

interface UpOpts {
  seed: boolean;
  noMigrate: boolean;
}

/** `penv up` — provision this worktree's isolated env. True no-op on main. */
export async function cmdUp(ctx: Ctx, opts: UpOpts): Promise<void> {
  const { id, ctx: gc } = resolveId();
  if (!id || !gc.root) {
    if (ctx.json) emit(ctx, { skipped: true, reason: 'not-a-worktree' });
    else say(ctx, 'penv: on main / not a worktree — no preview env to provision');
    return;
  }
  if (!hasScript(gc.root, 'provision.sh')) {
    fail(ctx, `no ${scriptPath(gc.root, 'provision.sh')} — run \`penv init\` to generate lifecycle scripts`, 'NO_SCRIPTS');
  }

  const env = {
    ...contractEnv(id, gc.root, gc.branch),
    PENV_SEED: opts.seed ? '1' : '',
    PENV_NO_MIGRATE: opts.noMigrate ? '1' : '',
  };

  say(ctx, `penv: provisioning ${id}…`);
  const code = await runScript(scriptPath(gc.root, 'provision.sh'), { cwd: gc.root, env });
  if (code !== 0) fail(ctx, `provision.sh exited ${code}`, 'PROVISION_FAILED', { id, code });

  if (opts.seed && hasScript(gc.root, 'seed.sh')) {
    say(ctx, `penv: seeding ${id}…`);
    const sc = await runScript(scriptPath(gc.root, 'seed.sh'), { cwd: gc.root, env });
    if (sc !== 0) fail(ctx, `seed.sh exited ${sc}`, 'SEED_FAILED', { id, code: sc });
  }

  const rec = readRecord(id);
  if (ctx.json) emit(ctx, { id, provisioned: true, record: rec, envFile: envFilePath(gc.root) });
  else say(ctx, `penv: ${id} ready → ${envFilePath(gc.root)}`);
}

/** `penv verify` — assert reachable AND isolated (delegates to verify.sh). */
export async function cmdVerify(ctx: Ctx): Promise<void> {
  const { id, ctx: gc } = resolveId();
  if (!id || !gc.root) {
    if (ctx.json) emit(ctx, { skipped: true, reason: 'not-a-worktree' });
    else say(ctx, 'penv: on main / not a worktree — nothing to verify');
    return;
  }
  if (!hasScript(gc.root, 'verify.sh')) {
    fail(ctx, `no ${scriptPath(gc.root, 'verify.sh')}`, 'NO_SCRIPTS');
  }
  const env = contractEnv(id, gc.root, gc.branch);
  const code = await runScript(scriptPath(gc.root, 'verify.sh'), { cwd: gc.root, env });
  if (ctx.json) emit(ctx, { id, verified: code === 0, code });
  if (code !== 0) process.exit(code);
  else say(ctx, `penv: ${id} verified ✓`);
}

/** `penv down` — stop a running stack if the repo defines how; else no-op. */
export async function cmdDown(ctx: Ctx): Promise<void> {
  const { id, ctx: gc } = resolveId();
  if (!id || !gc.root) {
    say(ctx, 'penv: on main / not a worktree — nothing to stop');
    return;
  }
  if (!hasScript(gc.root, 'down.sh')) {
    note(ctx, 'penv: no .preview/down.sh (run mechanism is detected/external) — nothing to stop');
    if (ctx.json) emit(ctx, { id, stopped: false, reason: 'no-down-script' });
    return;
  }
  const env = contractEnv(id, gc.root, gc.branch);
  const code = await runScript(scriptPath(gc.root, 'down.sh'), { cwd: gc.root, env });
  if (ctx.json) emit(ctx, { id, stopped: code === 0, code });
  if (code !== 0) process.exit(code);
}

/**
 * `penv destroy` — tear down this env's resources, then release its slots.
 *
 * Flush-before-release invariant: teardown.sh (which drops the DB / flushes the
 * redis index / removes the data dir) runs to completion BEFORE the ledger
 * record is removed. Removing the record frees those slots for reuse; doing it
 * after teardown guarantees a new env can't grab a slot mid-flush and get wiped.
 */
/**
 * `penv destroy [--id <id>] [--force]` — tear down this env's resources, then
 * release its slots.
 *
 * Flush-before-release invariant: teardown.sh (which drops the DB / flushes the
 * redis index / removes the data dir) runs to completion BEFORE the ledger
 * record is removed. Removing the record frees those slots for reuse; doing it
 * after teardown guarantees a new env can't grab a slot mid-flush and get wiped.
 *
 * `--id` exists for the orphan case: a worktree removed without destroying its
 * env leaves a record whose resources are still allocated, and cwd can no
 * longer resolve it. The worktree's own `.preview/teardown.sh` went with it, so
 * the main checkout's committed copy is used instead -- found via the
 * `common_dir` recorded at provisioning. A record without `common_dir` (written
 * before it existed) can only have its slots released, and says so.
 */
export async function cmdDestroy(
  ctx: Ctx,
  opts: { force: boolean; id?: string },
): Promise<void> {
  let id: string | null;
  let root: string | null;
  let branch: string | null;
  let record: ReturnType<typeof readRecord>;

  if (opts.id) {
    record = readRecord(opts.id);
    if (!record) {
      fail(ctx, `no env recorded with id "${opts.id}"`, 'UNKNOWN_ID', { id: opts.id });
      return;
    }
    id = record.id;
    root = record.repo_root;
    branch = record.branch;
  } else {
    const resolved = resolveId();
    id = resolved.id;
    root = resolved.ctx.root;
    branch = resolved.ctx.branch;
    if (!id || !root) {
      if (ctx.json) emit(ctx, { skipped: true, reason: 'not-a-worktree' });
      else say(ctx, 'penv: on main / not a worktree — nothing to destroy');
      return;
    }
    record = readRecord(id);
  }

  // Where teardown can run from. The worktree itself when it still exists;
  // otherwise the main checkout, which has the same committed script.
  let scriptRoot: string | null = null;
  let ranFromMain = false;
  if (existsSync(root) && hasScript(root, 'teardown.sh')) {
    scriptRoot = root;
  } else {
    const mainRoot = mainRootFromCommonDir(record?.common_dir ?? null);
    if (mainRoot && hasScript(mainRoot, 'teardown.sh')) {
      scriptRoot = mainRoot;
      ranFromMain = true;
    }
  }

  if (scriptRoot) {
    say(ctx, `penv: tearing down ${id}…`);
    if (ranFromMain) {
      note(ctx, `penv: worktree ${root} is gone — running teardown from ${scriptRoot}`);
    }
    // PENV_ROOT stays the env's own (possibly missing) root: teardown derives
    // resource names from PENV_ID and must not mistake the main checkout for
    // its own worktree. PENV_DIR points at the scripts actually being run.
    const env = {
      ...contractEnv(id, root, branch),
      PENV_DIR: previewDir(scriptRoot),
    };
    const code = await runScript(scriptPath(scriptRoot, 'teardown.sh'), { cwd: scriptRoot, env });
    if (code !== 0 && !opts.force) {
      fail(
        ctx,
        `teardown.sh exited ${code}; slots NOT released. Fix and retry, or \`penv destroy --force\``,
        'TEARDOWN_FAILED',
        { id, code },
      );
    }
    if (code !== 0) note(ctx, `penv: teardown.sh exited ${code} — forcing slot release anyway`);
  } else if (!existsSync(root)) {
    // Nothing to run: no recorded common dir, or the main checkout has no
    // teardown script. Releasing the slots is still correct -- the record is
    // the only thing this command owns -- but the resources it named may well
    // survive, and that has to be said out loud rather than reported as a
    // clean destroy.
    note(
      ctx,
      `penv: worktree ${root} is gone and no teardown script could be found` +
        `${record?.common_dir ? '' : ' (record predates common_dir)'}` +
        ' — releasing slots only. These may still exist: ' +
        describeAllocations(record),
    );
  }

  // Release slots only after teardown has flushed resources.
  await withLock(() => {
    removeRecord(id!);
  });
  const ef = envFilePath(root);
  if (existsSync(ef)) rmSync(ef);

  if (ctx.json) emit(ctx, { id, destroyed: true, teardownRan: Boolean(scriptRoot), ranFromMain });
  else say(ctx, `penv: ${id} destroyed (slots released)`);
}

/** Human-readable list of what a record had claimed. */
function describeAllocations(record: ReturnType<typeof readRecord>): string {
  if (!record) return 'nothing recorded';
  const parts: string[] = [];
  for (const value of Object.values(record.names)) parts.push(value);
  for (const [name, index] of Object.entries(record.indexes)) parts.push(`${name} index ${index}`);
  const ports = Object.values(record.ports);
  if (ports.length) parts.push(`ports ${ports.join(', ')}`);
  return parts.length ? parts.join('; ') : 'no recorded allocations';
}
