import { dirname, resolve } from 'path';
import { git } from './exec.ts';

export interface GitContext {
  /** Absolute path to the worktree root (git toplevel), or null if not in a repo. */
  root: string | null;
  /** Current branch name, or null if detached / not in a repo. */
  branch: string | null;
  /** True iff invoked inside a *linked* worktree (not the main checkout). */
  isWorktree: boolean;
  /**
   * Absolute path to the shared git dir (`<main-checkout>/.git`), or null
   * outside a repo. Recorded in the ledger so an env whose worktree has been
   * deleted can still find the main checkout's committed teardown script.
   */
  commonDir: string | null;
}

/**
 * Resolve git context for a directory.
 *
 * Worktree gating uses the structural difference between the per-worktree git
 * dir and the shared common dir: in the main checkout they are identical
 * (`.git`); in a linked worktree git-dir is `.../.git/worktrees/<name>` while
 * git-common-dir is `.../.git`. This is the same signal as ".git file vs dir"
 * but works without filesystem assumptions.
 */
export function gitContext(cwd: string = process.cwd()): GitContext {
  const root = git(['rev-parse', '--show-toplevel'], cwd);
  if (!root) {
    return { root: null, branch: null, isWorktree: false, commonDir: null };
  }

  const gitDir = git(['rev-parse', '--absolute-git-dir'], cwd);
  const commonDirRaw = git(['rev-parse', '--git-common-dir'], cwd);
  // --git-common-dir may be relative to cwd; resolve both to absolute.
  const commonDir = commonDirRaw ? resolve(cwd, commonDirRaw) : null;
  const isWorktree = !!gitDir && !!commonDir && resolve(gitDir) !== resolve(commonDir);

  // `git branch --show-current` is empty on detached HEAD.
  const branch = git(['branch', '--show-current'], cwd) || null;

  return { root, branch, isWorktree, commonDir };
}

/**
 * The main checkout's root, derived from a recorded common dir.
 *
 * The common dir is `<main-checkout>/.git` for an ordinary repo, so the main
 * root is its parent. Returns null for anything else (a bare repo, a
 * `--separate-git-dir` layout) rather than guessing, because the caller uses
 * this to decide whether it can run a teardown script from there.
 */
export function mainRootFromCommonDir(commonDir: string | null): string | null {
  if (!commonDir) return null;
  const parent = dirname(resolve(commonDir));
  const root = git(['rev-parse', '--show-toplevel'], parent);
  return root && resolve(root) === parent ? root : null;
}
