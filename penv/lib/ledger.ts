import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync } from 'fs';

/**
 * Allocation record — machine-local, global across repos.
 * Stored at ~/.penv/<id>.json. The lifecycle scripts in `.preview/` are the
 * per-repo artifact; this record is just the live-allocation bookkeeping.
 */
export interface PenvRecord {
  id: string;
  /** Reserved for multi-repo grouping; always null in v1. */
  workspace: string | null;
  /** Git toplevel of the worktree this env is anchored to (survives rename). */
  repo_root: string;
  branch: string | null;
  /** name -> port */
  ports: Record<string, number>;
  /** name -> integer index (e.g. redis db) */
  indexes: Record<string, number>;
  /** suffix -> namespaced name (e.g. preview -> preview_<id>) */
  names: Record<string, string>;
  /** opaque resources the teardown script may care about */
  resources: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export function ledgerDir(): string {
  return process.env.PENV_HOME || join(homedir(), '.penv');
}

export function ensureLedgerDir(): string {
  const dir = ledgerDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function recordPath(id: string): string {
  return join(ledgerDir(), `${id}.json`);
}

export function readRecord(id: string): PenvRecord | null {
  const p = recordPath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as PenvRecord;
  } catch {
    return null;
  }
}

/** Atomic write: temp file in the same dir, then rename. */
export function writeRecord(rec: PenvRecord): void {
  ensureLedgerDir();
  rec.updated_at = new Date().toISOString();
  const p = recordPath(rec.id);
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2));
  renameSync(tmp, p);
}

export function removeRecord(id: string): void {
  const p = recordPath(id);
  if (existsSync(p)) rmSync(p);
}

export function listRecords(): PenvRecord[] {
  const dir = ledgerDir();
  if (!existsSync(dir)) return [];
  const out: PenvRecord[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), 'utf8')) as PenvRecord);
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

/** Look up an env by its anchor path. This is what makes ids survive branch rename. */
export function findByRoot(root: string): PenvRecord | null {
  for (const rec of listRecords()) {
    if (rec.repo_root === root) return rec;
  }
  return null;
}

export function existingIds(): Set<string> {
  return new Set(listRecords().map((r) => r.id));
}

/** Every port claimed by any live env (optionally excluding one id). */
export function claimedPorts(excludeId?: string): Set<number> {
  const set = new Set<number>();
  for (const rec of listRecords()) {
    if (rec.id === excludeId) continue;
    for (const v of Object.values(rec.ports)) set.add(v);
  }
  return set;
}

/** Every index claimed under `name` by any live env (optionally excluding one id). */
export function claimedIndexes(name: string, excludeId?: string): Set<number> {
  const set = new Set<number>();
  for (const rec of listRecords()) {
    if (rec.id === excludeId) continue;
    const v = rec.indexes[name];
    if (typeof v === 'number') set.add(v);
  }
  return set;
}

/**
 * Every index in [min,max] claimed by any live env under ANY name (optionally
 * excluding one id). This is the "range = pool" model: two named indices that
 * share the same range share a resource (e.g. app + workers on one redis
 * instance), so they must be mutually distinct across all envs. Different
 * resources get non-overlapping ranges and never falsely conflict.
 */
export function claimedIndexesInRange(min: number, max: number, excludeId?: string): Set<number> {
  const set = new Set<number>();
  for (const rec of listRecords()) {
    if (rec.id === excludeId) continue;
    for (const v of Object.values(rec.indexes)) {
      if (typeof v === 'number' && v >= min && v <= max) set.add(v);
    }
  }
  return set;
}

export function newRecord(id: string, repoRoot: string, branch: string | null): PenvRecord {
  const now = new Date().toISOString();
  return {
    id,
    workspace: null,
    repo_root: repoRoot,
    branch,
    ports: {},
    indexes: {},
    names: {},
    resources: {},
    created_at: now,
    updated_at: now,
  };
}
