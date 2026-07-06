import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { ledgerDir, ensureLedgerDir } from './ledger.ts';

/**
 * Allocation lock — guards port/index claims so concurrent provisions can't
 * grab the same slot. Uses `mkdir` atomicity (works on macOS + Linux, no flock
 * dependency). Holder PID is recorded for stale-lock recovery after a crash.
 */
function lockDir(): string {
  return join(ledgerDir(), '.alloc-lock');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // EPERM means the process exists but we can't signal it -> alive.
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function acquire(timeoutMs = 30_000): Promise<void> {
  ensureLedgerDir();
  const dir = lockDir();
  const pidFile = join(dir, 'pid');
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(dir); // atomic: fails if it already exists
      writeFileSync(pidFile, String(process.pid));
      return;
    } catch {
      // Lock held — check liveness of the holder.
      let holder = 0;
      if (existsSync(pidFile)) {
        holder = parseInt(readFileSync(pidFile, 'utf8').trim() || '0', 10) || 0;
      }
      if (holder && !pidAlive(holder)) {
        // Stale lock from a dead process — reclaim.
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* race with another reclaimer; loop */
        }
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`penv: allocation lock held by pid ${holder || '?'} for >${timeoutMs / 1000}s; giving up`);
      }
      await sleep(200);
    }
  }
}

function release(): void {
  try {
    rmSync(lockDir(), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Run `fn` while holding the allocation lock; always releases. */
export async function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}
