import { withLock } from './lock.ts';
import {
  readRecord,
  writeRecord,
  newRecord,
  claimedPorts,
  claimedIndexesInRange,
  type PenvRecord,
} from './ledger.ts';
import { portFree } from './net.ts';

/** Default port band — high range to avoid clashing with common dev ports. */
export const DEFAULT_PORT_RANGE: [number, number] = [20000, 29999];

function loadOrCreate(id: string, root: string, branch: string | null): PenvRecord {
  return readRecord(id) ?? newRecord(id, root, branch);
}

/**
 * Idempotent, collision-free port for `name` under this env. Re-requesting the
 * same name returns the same port (recorded in the ledger), which is what makes
 * re-provisioning a no-op and gives teardown an exact release list for free.
 */
export async function getPort(
  id: string,
  root: string,
  branch: string | null,
  name: string,
  range: [number, number] = DEFAULT_PORT_RANGE,
): Promise<number> {
  return withLock(() => {
    const rec = loadOrCreate(id, root, branch);
    const existing = rec.ports[name];
    if (existing !== undefined) return existing;

    const claimed = claimedPorts(id);
    for (const v of Object.values(rec.ports)) claimed.add(v); // this env's other ports
    const [min, max] = range;
    for (let p = min; p <= max; p++) {
      if (claimed.has(p)) continue;
      if (!portFree(p)) continue;
      rec.ports[name] = p;
      writeRecord(rec);
      return p;
    }
    throw new Error(`penv: no free port in range ${min}-${max}`);
  });
}

/** Idempotent, collision-free integer index for `name` in [min,max] (e.g. redis db). */
export async function getIndex(
  id: string,
  root: string,
  branch: string | null,
  name: string,
  min: number,
  max: number,
): Promise<number> {
  return withLock(() => {
    const rec = loadOrCreate(id, root, branch);
    const existing = rec.indexes[name];
    if (existing !== undefined) return existing;

    // Range = pool: exclude every index already claimed in this range by any env
    // (any name) AND this env's own other names, so multiple named indices on one
    // shared instance (e.g. app + workers redis dbs) never collide.
    const claimed = claimedIndexesInRange(min, max, id);
    for (const v of Object.values(rec.indexes)) {
      if (v >= min && v <= max) claimed.add(v);
    }
    for (let i = min; i <= max; i++) {
      if (claimed.has(i)) continue;
      rec.indexes[name] = i;
      writeRecord(rec);
      return i;
    }
    throw new Error(`penv: no free index for "${name}" in range ${min}-${max}`);
  });
}

/** Namespaced name derived from the (already-unique) env id, e.g. preview -> preview_<id>. */
export async function getName(
  id: string,
  root: string,
  branch: string | null,
  suffix: string,
): Promise<string> {
  return withLock(() => {
    const rec = loadOrCreate(id, root, branch);
    const existing = rec.names[suffix];
    if (existing !== undefined) return existing;
    const value = `${suffix}_${id}`;
    rec.names[suffix] = value;
    writeRecord(rec);
    return value;
  });
}
