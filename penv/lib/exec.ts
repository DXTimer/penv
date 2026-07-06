/**
 * Tiny exec helpers for penv. Synchronous git/probe calls (CLI runs to
 * completion, so blocking is fine and keeps control flow simple), plus a
 * streaming runner for lifecycle scripts.
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run a command, capture output, never throw. */
export function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): ExecResult {
  const proc = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    stdout: proc.stdout ? proc.stdout.toString() : '',
    stderr: proc.stderr ? proc.stderr.toString() : '',
    code: proc.exitCode ?? 1,
  };
}

/** Run `git ...` in cwd; returns trimmed stdout or null on failure. */
export function git(args: string[], cwd?: string): string | null {
  const r = run(['git', ...args], { cwd });
  if (r.code !== 0) return null;
  return r.stdout.trim();
}

/**
 * Run a lifecycle script (bash) with inherited stdio so the user sees live
 * output. Returns the exit code.
 */
export async function runScript(
  scriptPath: string,
  opts: { cwd: string; env: Record<string, string>; stdin?: string } = { cwd: process.cwd(), env: {} },
): Promise<number> {
  const proc = Bun.spawn(['bash', scriptPath], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdin: opts.stdin !== undefined ? 'pipe' : 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (opts.stdin !== undefined && proc.stdin) {
    proc.stdin.write(opts.stdin);
    await proc.stdin.end();
  }
  return await proc.exited;
}
