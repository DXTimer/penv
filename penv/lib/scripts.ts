import { join } from 'path';
import { existsSync } from 'fs';

export const PREVIEW_DIR = '.preview';

export function previewDir(root: string): string {
  return join(root, PREVIEW_DIR);
}

export function scriptPath(root: string, name: string): string {
  return join(previewDir(root), name);
}

export function hasScript(root: string, name: string): boolean {
  return existsSync(scriptPath(root, name));
}

/**
 * Self-reference: how a lifecycle script should re-invoke penv.
 * - compiled binary: the executable path itself.
 * - dev (run via `bun bin/penv`): "<bun> <entry>".
 */
export function penvBin(): string {
  const exec = process.execPath;
  if (exec.endsWith('/penv') || exec.endsWith('\\penv')) return exec;
  const entry = process.argv[1];
  return entry ? `${exec} ${entry}` : 'penv';
}

/**
 * Guaranteed input env for every lifecycle script. The rest of the host
 * environment (PGHOST, REDIS_URL, etc.) passes through unchanged — those are
 * repo-specific and the script reads them directly.
 */
export function contractEnv(id: string, root: string, branch: string | null): Record<string, string> {
  return {
    PENV_ID: id,
    PENV_ROOT: root,
    PENV_DIR: previewDir(root),
    PENV_BRANCH: branch ?? '',
    PENV_BIN: penvBin(),
  };
}
