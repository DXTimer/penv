import { resolveId } from '../lib/id.ts';
import { gitContext } from '../lib/git.ts';
import { getPort, getIndex, getName, DEFAULT_PORT_RANGE } from '../lib/alloc.ts';
import { mergeEnv, parsePairs, envFilePath } from '../lib/envfile.ts';
import { readRecord, listRecords } from '../lib/ledger.ts';
import { emit, say, fail, type Ctx } from '../lib/output.ts';

/** `penv id` — stable id, empty (exit 0) on main / outside a repo. */
export function cmdId(ctx: Ctx): void {
  const { id } = resolveId();
  if (ctx.json) emit(ctx, { id: id ?? '' });
  else if (id) console.log(id);
  // else: print nothing (empty) — callers test for empty string
}

/** `penv is-worktree` — exit 0 in a linked worktree, 1 otherwise. */
export function cmdIsWorktree(ctx: Ctx): void {
  const c = gitContext();
  if (ctx.json) emit(ctx, { isWorktree: c.isWorktree });
  process.exit(c.isWorktree ? 0 : 1);
}

function parseRange(spec: string | undefined, fallback: [number, number]): [number, number] {
  if (!spec) return fallback;
  const m = spec.match(/^(\d+)-(\d+)$/);
  if (!m) throw new Error(`bad range "${spec}", expected e.g. 2-63`);
  return [parseInt(m[1]!, 10), parseInt(m[2]!, 10)];
}

/** `penv get port|index|name <name> [a-b]` */
export async function cmdGet(ctx: Ctx, kind: string, name: string, rangeSpec?: string): Promise<void> {
  const { id, ctx: gc } = resolveId();
  if (!id || !gc.root) fail(ctx, 'not in a worktree (get is only valid inside a linked worktree)', 'NOT_A_WORKTREE');
  if (!name) fail(ctx, `usage: penv get ${kind || '<port|index|name>'} <name> [a-b]`, 'BAD_USAGE');

  if (kind === 'port') {
    const range = parseRange(rangeSpec, DEFAULT_PORT_RANGE);
    const port = await getPort(id, gc.root, gc.branch, name, range);
    if (ctx.json) emit(ctx, { name, port });
    else console.log(String(port));
  } else if (kind === 'index') {
    const range = parseRange(rangeSpec, [0, 15]);
    const idx = await getIndex(id, gc.root, gc.branch, name, range[0], range[1]);
    if (ctx.json) emit(ctx, { name, index: idx });
    else console.log(String(idx));
  } else if (kind === 'name') {
    const value = await getName(id, gc.root, gc.branch, name);
    if (ctx.json) emit(ctx, { suffix: name, value });
    else console.log(value);
  } else {
    fail(ctx, `unknown get kind "${kind}" (expected port|index|name)`, 'BAD_USAGE');
  }
}

/**
 * `penv env` — merge KEY=VALUE pairs into <root>/.env.preview.
 * Reads pairs from stdin (heredoc) and/or trailing args.
 */
export async function cmdEnv(ctx: Ctx, argPairs: string[]): Promise<void> {
  const { id, ctx: gc } = resolveId();
  if (!id || !gc.root) fail(ctx, 'not in a worktree', 'NOT_A_WORKTREE');

  let pairs: Array<[string, string]> = [];
  if (!process.stdin.isTTY) {
    const stdinText = await Bun.stdin.text();
    if (stdinText.trim()) pairs = pairs.concat(parsePairs(stdinText));
  }
  if (argPairs.length) pairs = pairs.concat(parsePairs(argPairs.join('\n')));

  if (!pairs.length) fail(ctx, 'no KEY=VALUE pairs given (pass via stdin heredoc or args)', 'BAD_USAGE');

  const path = mergeEnv(gc.root, pairs);
  if (ctx.json) emit(ctx, { path, written: pairs.map(([k]) => k) });
  else say(ctx, `penv: wrote ${pairs.length} var(s) to ${path}`);
}

/** `penv status` — the current worktree's allocation record. */
export function cmdStatus(ctx: Ctx): void {
  const { id, ctx: gc } = resolveId();
  if (!id) {
    if (ctx.json) emit(ctx, { onMain: true, isWorktree: gc.isWorktree });
    else say(ctx, gc.root ? 'penv: on main checkout — no preview env' : 'penv: not in a git repo');
    return;
  }
  const rec = readRecord(id);
  if (ctx.json) {
    emit(ctx, { id, root: gc.root, branch: gc.branch, record: rec, envFile: gc.root ? envFilePath(gc.root) : null });
    return;
  }
  say(ctx, `id:      ${id}`);
  say(ctx, `root:    ${gc.root}`);
  say(ctx, `branch:  ${gc.branch ?? '(detached)'}`);
  if (rec) {
    if (Object.keys(rec.ports).length) say(ctx, `ports:   ${JSON.stringify(rec.ports)}`);
    if (Object.keys(rec.indexes).length) say(ctx, `indexes: ${JSON.stringify(rec.indexes)}`);
    if (Object.keys(rec.names).length) say(ctx, `names:   ${JSON.stringify(rec.names)}`);
  } else {
    say(ctx, 'state:   not provisioned yet (no record)');
  }
}

/** `penv list` — every live env on this machine. */
export function cmdList(ctx: Ctx): void {
  const recs = listRecords();
  if (ctx.json) {
    emit(ctx, { envs: recs });
    return;
  }
  if (!recs.length) {
    say(ctx, 'penv: no live preview envs');
    return;
  }
  for (const r of recs) {
    const ports = Object.entries(r.ports).map(([k, v]) => `${k}=${v}`).join(' ');
    say(ctx, `${r.id.padEnd(28)} ${r.branch ?? '-'}  ${ports}`);
  }
}
