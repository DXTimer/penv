import { existsSync, rmSync } from 'fs';
import { resolveId } from '../lib/id.ts';
import { withLock } from '../lib/lock.ts';
import { removeRecord, readRecord } from '../lib/ledger.ts';
import { runScript } from '../lib/exec.ts';
import { hasScript, scriptPath, contractEnv } from '../lib/scripts.ts';
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
export async function cmdDestroy(ctx: Ctx, opts: { force: boolean }): Promise<void> {
  const { id, ctx: gc } = resolveId();
  if (!id || !gc.root) {
    if (ctx.json) emit(ctx, { skipped: true, reason: 'not-a-worktree' });
    else say(ctx, 'penv: on main / not a worktree — nothing to destroy');
    return;
  }

  if (hasScript(gc.root, 'teardown.sh')) {
    say(ctx, `penv: tearing down ${id}…`);
    const env = contractEnv(id, gc.root, gc.branch);
    const code = await runScript(scriptPath(gc.root, 'teardown.sh'), { cwd: gc.root, env });
    if (code !== 0 && !opts.force) {
      fail(
        ctx,
        `teardown.sh exited ${code}; slots NOT released. Fix and retry, or \`penv destroy --force\``,
        'TEARDOWN_FAILED',
        { id, code },
      );
    }
    if (code !== 0) note(ctx, `penv: teardown.sh exited ${code} — forcing slot release anyway`);
  }

  // Release slots only after teardown has flushed resources.
  await withLock(() => {
    removeRecord(id);
  });
  const ef = envFilePath(gc.root);
  if (existsSync(ef)) rmSync(ef);

  if (ctx.json) emit(ctx, { id, destroyed: true });
  else say(ctx, `penv: ${id} destroyed (slots released)`);
}
