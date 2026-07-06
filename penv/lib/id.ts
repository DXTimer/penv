import { gitContext, type GitContext } from './git.ts';
import { findByRoot, existingIds } from './ledger.ts';

/** lowercase, non-alnum -> _, collapse/trim, cap 48 chars. */
export function sanitize(branch: string): string {
  const s = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return s || 'env';
}

function hashPath(p: string): string {
  return `env_${Bun.hash(p).toString(16).slice(0, 12)}`;
}

export interface ResolvedId {
  id: string | null;
  ctx: GitContext;
}

/**
 * Stable id for the current worktree, anchored to its git toplevel path.
 *
 * - null on the main checkout / outside a repo (so `penv id` is empty there).
 * - If a record already exists for this path, reuse its id (survives branch
 *   rename / `git switch`).
 * - Otherwise derive from the branch (or a path hash when detached) and ensure
 *   global uniqueness against other repos' envs in the ledger.
 */
export function resolveId(cwd: string = process.cwd()): ResolvedId {
  const ctx = gitContext(cwd);
  if (!ctx.root || !ctx.isWorktree) return { id: null, ctx };

  const existing = findByRoot(ctx.root);
  if (existing) return { id: existing.id, ctx };

  const base = ctx.branch ? sanitize(ctx.branch) : hashPath(ctx.root);
  const taken = existingIds();
  if (!taken.has(base)) return { id: base, ctx };

  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 44)}_${n}`;
    if (!taken.has(candidate)) return { id: candidate, ctx };
  }
}
