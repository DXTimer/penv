/**
 * penv doctor — deterministic, NO-network, NO-agent stack detector.
 *
 * Reads files from the repo root; never executes anything, never calls out.
 * Returns a DoctorReport that drives both human output and script generation.
 */

import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Tier = 0 | 1 | 2;
export type Confidence = 'auto' | 'escalate';
export type RunMechanism =
  | 'Procfile.preview'
  | 'Procfile'
  | 'compose'
  | 'package.json:dev'
  | 'package.json:start'
  | 'Makefile:dev'
  | 'framework:next'
  | 'framework:vite'
  | 'unknown';

export type MigrationTool = 'alembic' | 'prisma' | 'drizzle' | 'knex' | 'flyway' | 'sequelize' | 'none';
export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm' | 'poetry' | 'pip' | 'unknown';
export type AgentIntegration = 'claude-code' | 'codex' | 'none';

export interface StatefulService {
  name: string; // e.g. "postgres", "redis", "kafka"
  source: string; // where it was detected, e.g. "compose.yml"
}

export interface EnvVar {
  key: string;
  purpose: 'db' | 'redis' | 'port' | 'data-dir' | 'other';
  defaultValue?: string | undefined;
}

export interface Blocker {
  kind: 'hardcoded-port' | 'missing-migration-tool' | 'ambiguous-tier' | 'external-resource' | 'other';
  detail: string;
  file?: string | undefined;
}

export interface DoctorReport {
  root: string;
  tier: Tier;
  tierReason: string;
  confidence: Confidence;
  run: RunMechanism;
  runCommand?: string | undefined;
  migration: MigrationTool;
  packageManager: PackageManager;
  envVars: EnvVar[];
  statefulServices: StatefulService[];
  agents: AgentIntegration[];
  existingPreview: boolean; // .preview/provision.sh already present
  existingScripts: string[]; // existing .preview/* filenames
  existingPenvIntegration: boolean; // .wt/worktrees.json already has penv up
  existingOtherPreview: boolean; // scripts/preview-env.sh or similar non-penv preview setup
  blockers: Blocker[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function exists(...paths: string[]): boolean {
  return paths.some((p) => existsSync(p));
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir) as string[];
  } catch {
    return [];
  }
}

// Scan a directory tree up to maxDepth for files matching a predicate.
function findFiles(
  root: string,
  predicate: (relPath: string) => boolean,
  maxDepth = 3,
): string[] {
  const results: string[] = [];
  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent<string>[];
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && depth > 0) continue; // skip hidden subdirs
      const rel = dir === root ? e.name : `${dir.slice(root.length + 1)}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '__pycache__' || e.name === '.git') continue;
        walk(join(dir, e.name), depth + 1);
      } else if (predicate(rel)) {
        results.push(rel);
      }
    }
  }
  walk(root, 0);
  return results;
}

// Read all .env.example / .env.* files (not .env itself to avoid secrets).
function readEnvFiles(root: string): string {
  const candidates = [
    join(root, '.env.example'),
    join(root, '.env.sample'),
    join(root, '.env.template'),
    join(root, '.env.defaults'),
  ];
  // Also recurse into apps/* for monorepos.
  const appsDir = join(root, 'apps');
  if (existsSync(appsDir)) {
    for (const app of listDir(appsDir)) {
      candidates.push(join(appsDir, app, '.env.example'));
      candidates.push(join(appsDir, app, '.env.sample'));
    }
  }
  return candidates
    .map((p) => readText(p) ?? '')
    .filter((t) => t.length > 0)
    .join('\n');
}

// Extract KEY=... lines from env file text.
function parseEnvKeys(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key) map.set(key, val);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Sub-detectors
// ---------------------------------------------------------------------------

function detectStatefulServices(root: string): StatefulService[] {
  const services: StatefulService[] = [];
  const composeNames = ['compose.yml', 'docker-compose.yml', 'compose.yaml', 'docker-compose.yaml'];
  const statefulImages = [
    'postgres', 'postgresql', 'mysql', 'mariadb', 'mongodb', 'mongo',
    'redis', 'kafka', 'redpanda', 'rabbitmq', 'elasticsearch', 'cassandra',
    'clickhouse', 'meilisearch',
  ];
  for (const name of composeNames) {
    const text = readText(join(root, name));
    if (!text) continue;
    for (const svc of statefulImages) {
      if (text.includes(svc)) {
        services.push({ name: svc, source: name });
      }
    }
    break; // only first found compose file
  }
  return services;
}

function detectSqlite(root: string): boolean {
  // Check .gitignore for *.sqlite patterns
  const gitignore = readText(join(root, '.gitignore')) ?? '';
  if (/\*\.sqlite[3]?$/.test(gitignore) || /\.sqlite\b/.test(gitignore)) return true;

  // Check package.json deps for better-sqlite3
  const pkgJson = readText(join(root, 'package.json')) ?? '';
  if (pkgJson.includes('better-sqlite3')) return true;

  // Check source files (scan up to 3 levels) for DatabaseSync / better-sqlite3 imports
  const sourceFiles = findFiles(
    root,
    (p) => p.endsWith('.ts') || p.endsWith('.js') || p.endsWith('.mjs'),
    3,
  );
  for (const rel of sourceFiles) {
    const text = readText(join(root, rel)) ?? '';
    if (text.includes('DatabaseSync') || text.includes("from 'node:sqlite'") || text.includes('better-sqlite3')) {
      return true;
    }
  }

  // Check prisma schema
  const prismaSchema = readText(join(root, 'prisma', 'schema.prisma'));
  if (prismaSchema && prismaSchema.includes('provider = "sqlite"')) return true;

  return false;
}

function detectMigration(root: string): MigrationTool {
  if (exists(join(root, 'alembic.ini')) || exists(join(root, 'apps', 'backend', 'alembic.ini'))) return 'alembic';
  if (exists(join(root, 'prisma', 'schema.prisma'))) return 'prisma';
  const pkgJson = readText(join(root, 'package.json')) ?? '';
  if (pkgJson.includes('"drizzle-kit"') || pkgJson.includes('"drizzle-orm"')) return 'drizzle';
  if (pkgJson.includes('"knex"')) return 'knex';
  if (pkgJson.includes('"sequelize"')) return 'sequelize';
  if (
    exists(join(root, 'flyway.conf')) ||
    exists(join(root, 'flyway.toml')) ||
    findFiles(root, (p) => p.includes('flyway'), 2).length > 0
  ) return 'flyway';
  return 'none';
}

function detectPackageManager(root: string): PackageManager {
  if (exists(join(root, 'bun.lock')) || exists(join(root, 'bun.lockb'))) return 'bun';
  if (exists(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (exists(join(root, 'yarn.lock'))) return 'yarn';
  // poetry: check pyproject.toml has [tool.poetry]
  const pyproject = readText(join(root, 'pyproject.toml'))
    ?? readText(join(root, 'apps', 'backend', 'pyproject.toml'));
  if (pyproject && pyproject.includes('[tool.poetry]')) return 'poetry';
  if (exists(join(root, 'requirements.txt'))) return 'pip';
  if (exists(join(root, 'package-lock.json'))) return 'npm';
  if (exists(join(root, 'package.json'))) return 'npm';
  return 'unknown';
}

function detectRunMechanism(root: string): { run: RunMechanism; cmd?: string | undefined } {
  if (exists(join(root, '.preview', 'Procfile.preview')) || exists(join(root, 'Procfile.preview'))) {
    return { run: 'Procfile.preview', cmd: 'overmind start -f Procfile.preview' };
  }
  if (exists(join(root, 'Procfile'))) {
    return { run: 'Procfile', cmd: 'overmind start' };
  }
  const composeNames = ['compose.yml', 'docker-compose.yml', 'compose.yaml', 'docker-compose.yaml'];
  for (const name of composeNames) {
    if (exists(join(root, name))) return { run: 'compose', cmd: `docker compose up -d` };
  }
  const pkgJson = readText(join(root, 'package.json'));
  if (pkgJson) {
    let scripts: Record<string, string> = {};
    try {
      scripts = JSON.parse(pkgJson)?.scripts ?? {};
    } catch {
      /* malformed package.json — degrade, don't crash doctor/init */
    }
    if (scripts['dev']) return { run: 'package.json:dev', cmd: 'npm run dev' };
    if (scripts['start']) return { run: 'package.json:start', cmd: 'npm run start' };
  }
  const makefile = readText(join(root, 'Makefile'));
  if (makefile && /^dev:/m.test(makefile)) return { run: 'Makefile:dev', cmd: 'make dev' };
  // Framework defaults
  if (exists(join(root, 'next.config.ts')) || exists(join(root, 'next.config.js'))) {
    return { run: 'framework:next', cmd: 'next dev' };
  }
  if (exists(join(root, 'vite.config.ts')) || exists(join(root, 'vite.config.js'))) {
    return { run: 'framework:vite', cmd: 'vite' };
  }
  return { run: 'unknown' };
}

function detectAgents(root: string): AgentIntegration[] {
  const agents: AgentIntegration[] = [];
  if (exists(join(root, '.claude'))) agents.push('claude-code');
  // Codex: an explicit `.codex/` dir, or the repo is a registered Codex project
  // (~/.codex/config.toml lists its path). AGENTS.md alone is NOT a codex signal —
  // it's a cross-agent convention that Claude Code reads too.
  if (exists(join(root, '.codex')) || isCodexProject(root)) agents.push('codex');
  return agents;
}

function isCodexProject(root: string): boolean {
  let cfg: string;
  try {
    cfg = readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8');
  } catch {
    return false;
  }
  // Codex registers the MAIN checkout path; if init runs inside a worktree, also
  // check the main worktree path (derived from the .git file — no git exec).
  const candidates = [root];
  const main = mainWorktreePath(root);
  if (main && main !== root) candidates.push(main);
  return candidates.some((p) => cfg.includes(`"${p}"`)); // [projects."<path>"]
}

/** Main checkout path for `root` (root itself if it's the main checkout), via the .git file. */
function mainWorktreePath(root: string): string | null {
  const dotGit = join(root, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return root; // main checkout
    const m = readFileSync(dotGit, 'utf8').trim().match(/^gitdir:\s*(.+)$/);
    if (!m) return null;
    const idx = m[1]!.indexOf('/.git/worktrees/'); // <main>/.git/worktrees/<name>
    return idx >= 0 ? m[1]!.slice(0, idx) : null;
  } catch {
    return null;
  }
}

function detectEnvVars(root: string): EnvVar[] {
  const text = readEnvFiles(root);
  const keys = parseEnvKeys(text);
  const vars: EnvVar[] = [];

  for (const [key, val] of keys) {
    let purpose: EnvVar['purpose'] = 'other';
    if (/DATABASE_URL|DB_URL|POSTGRES_URL|MYSQL_URL|MONGO_URL|MONGODB_URI/.test(key)) purpose = 'db';
    else if (/REDIS_URL|REDIS_HOST/.test(key)) purpose = 'redis';
    else if (/PORT$|_PORT$|DAEMON_PORT/.test(key)) purpose = 'port';
    else if (/DATA_DIR$|_DATA_DIR$|STORAGE_DIR$/.test(key)) purpose = 'data-dir';
    else continue; // skip non-relevant vars

    vars.push({ key, purpose, defaultValue: val || undefined });
  }

  return vars;
}

function detectBlockers(
  root: string,
  tier: Tier,
  migration: MigrationTool,
  stateful: StatefulService[],
): Blocker[] {
  const blockers: Blocker[] = [];

  // Hardcoded port in vite config
  const viteConfig =
    readText(join(root, 'vite.config.ts'))
    ?? readText(join(root, 'vite.config.js'))
    ?? readText(join(root, 'packages', 'control', 'vite.config.ts'));
  if (viteConfig && /server\s*:\s*\{[^}]*port\s*:\s*\d+/.test(viteConfig)) {
    const m = viteConfig.match(/port\s*:\s*(\d+)/);
    if (m) {
      blockers.push({
        kind: 'hardcoded-port',
        detail: `vite server.port is hardcoded to ${m[1]!} — must be driven by PORT env var for isolation`,
        file: 'vite.config.ts',
      });
    }
  }

  // Tier 1 with no migration tool detected (might be OK, but worth noting)
  if (tier === 1 && migration === 'none' && stateful.some((s) => ['postgres', 'mysql', 'mariadb', 'mongodb', 'mongo'].includes(s.name))) {
    blockers.push({
      kind: 'missing-migration-tool',
      detail: 'Tier 1 relational DB detected but no migration tool found — provision.sh cannot run migrations automatically',
    });
  }

  return blockers;
}

// ---------------------------------------------------------------------------
// Tier classification
// ---------------------------------------------------------------------------

function classifyTier(
  stateful: StatefulService[],
  sqliteDetected: boolean,
  migration: MigrationTool,
  envVars: EnvVar[],
): { tier: Tier; reason: string } {
  const hasDB = envVars.some((v) => v.purpose === 'db');
  const hasRedis = envVars.some((v) => v.purpose === 'redis');
  const hasMigration = migration !== 'none';
  const hasStatefulSvc = stateful.length > 0;
  const hasDataDir = envVars.some((v) => v.purpose === 'data-dir');

  if (hasStatefulSvc || hasDB || hasRedis || hasMigration) {
    // If the ONLY stateful signal is sqlite with no shared services, treat as Tier 0
    if (
      sqliteDetected &&
      !hasStatefulSvc &&
      !hasDB &&
      !hasRedis &&
      migration === 'none'
    ) {
      return {
        tier: 0,
        reason: 'SQLite detected with no compose services / DB URL → file-level isolation',
      };
    }
    return {
      tier: 1,
      reason: [
        hasStatefulSvc ? `compose services: ${stateful.map((s) => s.name).join(', ')}` : null,
        hasDB ? 'DATABASE_URL detected' : null,
        hasRedis ? 'REDIS_URL detected' : null,
        hasMigration ? `migration: ${migration}` : null,
      ]
        .filter(Boolean)
        .join('; '),
    };
  }

  if (sqliteDetected || hasDataDir) {
    return {
      tier: 0,
      reason: sqliteDetected
        ? 'SQLite + data-dir isolation (no shared services detected)'
        : 'data-dir isolation (no shared services detected)',
    };
  }

  // Nothing stateful — still Tier 0 (port-only isolation)
  return { tier: 0, reason: 'no stateful services detected — port-only isolation' };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function runDoctor(root: string): DoctorReport {
  const statefulServices = detectStatefulServices(root);
  const sqliteDetected = detectSqlite(root);
  const migration = detectMigration(root);
  const packageManager = detectPackageManager(root);
  const { run: runMech, cmd: runCmd } = detectRunMechanism(root);
  const agents = detectAgents(root);
  const envVars = detectEnvVars(root);

  const { tier, reason: tierReason } = classifyTier(
    statefulServices,
    sqliteDetected,
    migration,
    envVars,
  );

  const blockers = detectBlockers(root, tier, migration, statefulServices);

  // Existing preview setup detection
  const existingPreview = exists(join(root, '.preview', 'provision.sh'));
  const existingScripts = listDir(join(root, '.preview')).filter((f) =>
    f.endsWith('.sh'),
  );

  // Check if .wt/worktrees.json already has penv integration
  const wtJson = readText(join(root, '.wt', 'worktrees.json')) ?? '';
  const existingPenvIntegration = wtJson.includes('penv up') || wtJson.includes('penv destroy');

  // Check for other non-penv preview systems (scripts/preview-env.sh)
  const existingOtherPreview =
    exists(join(root, 'scripts', 'preview-env.sh')) ||
    (!existingPreview &&
      (wtJson.includes('preview-env.sh') || wtJson.includes('preview-env up')));

  const confidence: Confidence =
    tier === 2 || blockers.some((b) => b.kind !== 'missing-migration-tool')
      ? 'escalate'
      : 'auto';

  return {
    root,
    tier,
    tierReason,
    confidence,
    run: runMech,
    runCommand: runCmd,
    migration,
    packageManager,
    envVars,
    statefulServices,
    agents,
    existingPreview,
    existingScripts,
    existingPenvIntegration,
    existingOtherPreview,
    blockers,
  };
}

// ---------------------------------------------------------------------------
// Script generation (Tier 0 / Tier 1 only)
// ---------------------------------------------------------------------------

export interface GeneratedScripts {
  'provision.sh': string;
  'verify.sh': string;
  'teardown.sh': string;
  'seed.sh'?: string | undefined;
}

function portVarName(vars: EnvVar[]): string {
  const found = vars.find((v) => v.purpose === 'port');
  return found?.key ?? 'APP_PORT';
}

function dataDirVarName(vars: EnvVar[]): string {
  const found = vars.find((v) => v.purpose === 'data-dir');
  return found?.key ?? 'APP_DATA_DIR';
}

function dbUrlVarName(vars: EnvVar[]): string {
  const found = vars.find((v) => v.purpose === 'db');
  return found?.key ?? 'DATABASE_URL';
}

function redisUrlVarName(vars: EnvVar[]): string {
  const found = vars.find((v) => v.purpose === 'redis');
  return found?.key ?? 'REDIS_URL';
}

function migrationCommand(tool: MigrationTool, pm: PackageManager): string {
  switch (tool) {
    case 'alembic':
      return pm === 'poetry'
        ? '(cd apps/backend && poetry run alembic upgrade head)'
        : 'alembic upgrade head';
    case 'prisma':
      return 'npx prisma migrate deploy';
    case 'drizzle':
      return 'npx drizzle-kit migrate';
    case 'knex':
      return 'npx knex migrate:latest';
    case 'flyway':
      return 'flyway migrate';
    case 'sequelize':
      return 'npx sequelize-cli db:migrate';
    default:
      return '';
  }
}

export function generateScripts(report: DoctorReport): GeneratedScripts {
  if (report.tier === 0) return generateTier0Scripts(report);
  return generateTier1Scripts(report);
}

function generateTier0Scripts(report: DoctorReport): GeneratedScripts {
  const portVar = portVarName(report.envVars);
  const dataDirVar = dataDirVarName(report.envVars);
  const runCmd = report.runCommand ?? 'npm run dev';

  const provision = `#!/usr/bin/env bash
set -euo pipefail
id="$PENV_ID"
data="$PENV_ROOT/.penv/$id"
port=$($PENV_BIN get port app)
mkdir -p "$data"
$PENV_BIN env <<EOF
${dataDirVar}=$data
${portVar}=$port
EOF
`;

  const verify = `#!/usr/bin/env bash
set -euo pipefail
set -a; source "$PENV_ROOT/.env.preview"; set +a
case "$${dataDirVar}" in "$PENV_ROOT/.penv/$PENV_ID") ;; *) echo "FAIL: data dir not isolated"; exit 1;; esac
[ -n "\${${portVar}:-}" ] || { echo "FAIL: no port"; exit 1; }
# reachable: boot, probe, stop
# (${runCmd} &) ; sleep 2 ; curl -fsS "http://127.0.0.1:$${portVar}/health" ; kill %1
echo "ok: port=$${portVar} data=$${dataDirVar}"
`;

  const teardown = `#!/usr/bin/env bash
set -euo pipefail
if [ -f "$PENV_ROOT/.env.preview" ]; then set -a; source "$PENV_ROOT/.env.preview"; set +a; fi
rm -rf "\${${dataDirVar}:-$PENV_ROOT/.penv/$PENV_ID}"
`;

  return { 'provision.sh': provision, 'verify.sh': verify, 'teardown.sh': teardown };
}

function generateTier1Scripts(report: DoctorReport): GeneratedScripts {
  const dbVar = dbUrlVarName(report.envVars);
  const redisVar = redisUrlVarName(report.envVars);
  const hasRedis = report.envVars.some((v) => v.purpose === 'redis');
  const migrateCmd = migrationCommand(report.migration, report.packageManager);

  // Derive PGHOST/PGPORT from the default DATABASE_URL value
  const dbDefault = report.envVars.find((v) => v.purpose === 'db')?.defaultValue ?? '';
  const hostMatch = dbDefault.match(/[@/]([^:/@]+):(\d+)\//);
  const pgHost = hostMatch ? hostMatch[1]! : 'localhost';
  const pgPort = hostMatch ? hostMatch[2]! : '5432';

  const portAllocLines = report.envVars
    .filter((v) => v.purpose === 'port')
    .map((v) => `${v.key}=$($PENV_BIN get port ${v.key.toLowerCase().replace(/_port$/, '').replace(/_/g, '-')})`)
    .join('\n');

  const envHeredocLines: string[] = [];
  envHeredocLines.push(`${dbVar}=postgresql://$PGUSER@$PGHOST:$PGPORT/$db`);
  if (hasRedis) {
    envHeredocLines.push(`${redisVar}=redis://\${REDIS_HOST:-localhost}:\${REDIS_PORT:-6379}/$redis_idx`);
  }
  for (const v of report.envVars.filter((vv) => vv.purpose === 'port')) {
    envHeredocLines.push(`${v.key}=$${v.key}`);
  }

  const migrationBlock = migrateCmd
    ? `[ "$PENV_NO_MIGRATE" = 1 ] || ${migrateCmd}\n`
    : '# no migration tool detected\n';

  const redisIdxLine = hasRedis ? `redis_idx=$($PENV_BIN get index redis 2-63)\n` : '';
  const redisVerifyLine = hasRedis
    ? `case "$${redisVar}" in */0) echo "FAIL: redis on shared db 0"; exit 1;; esac\n`
    : '';

  const provision = `#!/usr/bin/env bash
set -euo pipefail
id="$PENV_ID"
PGHOST="\${PGHOST:-${pgHost}}"; PGPORT="\${PGPORT:-${pgPort}}"; PGUSER="\${PGUSER:-postgres}"
db="preview_\${id}"
${redisIdxLine}${portAllocLines ? portAllocLines + '\n' : ''}
createdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$db" 2>/dev/null || true
${migrationBlock}
$PENV_BIN env <<EOF
${envHeredocLines.join('\n')}
EOF
`;

  const verify = `#!/usr/bin/env bash
set -euo pipefail
set -a; source "$PENV_ROOT/.env.preview"; set +a
case "$${dbVar}" in *"/preview_$PENV_ID") ;; *) echo "FAIL: DB not isolated"; exit 1;; esac
${redisVerifyLine}psql "$${dbVar}" -c 'SELECT 1' >/dev/null || { echo "FAIL: db unreachable"; exit 1; }
echo "ok: $${dbVar}${hasRedis ? '  $' + redisVar : ''}"
`;

  const teardown = `#!/usr/bin/env bash
set -euo pipefail
PGHOST="\${PGHOST:-${pgHost}}"; PGPORT="\${PGPORT:-${pgPort}}"; PGUSER="\${PGUSER:-postgres}"
db="preview_\${PENV_ID}"
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres \\
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$db'" >/dev/null 2>&1 || true
dropdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$db" 2>/dev/null || true
${
  hasRedis
    ? `if [ -f "$PENV_ROOT/.env.preview" ]; then
  set -a; . "$PENV_ROOT/.env.preview"; set +a
  idx="\${${redisVar}##*/}"   # index = last path segment of the redis URL (portable; no GNU sed)
  [ -n "$idx" ] && redis-cli -h "\${REDIS_HOST:-localhost}" -p "\${REDIS_PORT:-6379}" -n "$idx" flushdb >/dev/null 2>&1 || true
fi`
    : ''
}
`;

  const seed = `#!/usr/bin/env bash
set -euo pipefail
PGHOST="\${PGHOST:-${pgHost}}"; PGPORT="\${PGPORT:-${pgPort}}"; PGUSER="\${PGUSER:-postgres}"
db="preview_\${PENV_ID}"; template="\${PENV_SEED_TEMPLATE:-preview_seed_template}"
dropdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$db" 2>/dev/null || true
createdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -T "$template" "$db"
`;

  return {
    'provision.sh': provision,
    'verify.sh': verify,
    'teardown.sh': teardown,
    'seed.sh': seed,
  };
}

// ---------------------------------------------------------------------------
// bash -n syntax check
// ---------------------------------------------------------------------------

export interface SyntaxResult {
  script: string;
  ok: boolean;
  error?: string | undefined;
}

export function syntaxCheck(scripts: GeneratedScripts): SyntaxResult[] {
  const results: SyntaxResult[] = [];
  for (const [name, content] of Object.entries(scripts)) {
    if (!content) continue;
    const proc = Bun.spawnSync(['bash', '-n', '-'], {
      stdin: Buffer.from(content),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const ok = proc.exitCode === 0;
    results.push({
      script: name,
      ok,
      error: ok ? undefined : proc.stderr?.toString().trim() || 'syntax error',
    });
  }
  return results;
}
