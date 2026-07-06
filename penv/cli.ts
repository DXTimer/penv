import type { Ctx } from './lib/output.ts';
import { cmdId, cmdIsWorktree, cmdGet, cmdEnv, cmdStatus, cmdList } from './commands/primitives.ts';
import { cmdUp, cmdVerify, cmdDown, cmdDestroy, cmdSession } from './commands/lifecycle.ts';
import { cmdInit, cmdDoctor } from './commands/init.ts';
import { VERSION } from './version.ts';

const HELP = `penv — collision-safe preview environments, per git worktree

Primitives (call from .preview/*.sh):
  penv id                       Stable env id (empty on main)
  penv is-worktree              Exit 0 in a linked worktree, 1 otherwise
  penv get port  <name> [a-b]   Idempotent, collision-free port
  penv get index <name> <a-b>   Idempotent, collision-free integer (e.g. redis db)
  penv get name  <suffix>       Namespaced name, e.g. preview_<id>
  penv env [KEY=VAL ...]        Atomic merge into .env.preview (also reads stdin)

Lifecycle:
  penv up [--seed] [--no-migrate]   Run .preview/provision.sh (+ seed.sh)
  penv verify                       Run .preview/verify.sh (reachable + isolated)
  penv down                         Stop the stack (if .preview/down.sh exists)
  penv destroy [--force]            Run teardown.sh, then release slots
  penv status                       This worktree's allocation record
  penv session                      Inject preview ctx (SessionStart hook); no-op on main
  penv list                         All live envs on this machine

Setup:
  penv doctor                   Detect stack/tier/run/agents (report only)
  penv init                     Generate .preview/* + agent integration

Flags: --json  --verbose/-v  --force/-f  --seed  --no-migrate  --help/-h  --version/-V`;

interface Parsed {
  positional: string[];
  flags: Set<string>;
}

function parse(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Set<string>();
  for (const a of argv) {
    if (a === '--json') flags.add('json');
    else if (a === '--verbose' || a === '-v') flags.add('verbose');
    else if (a === '--force' || a === '-f') flags.add('force');
    else if (a === '--seed') flags.add('seed');
    else if (a === '--no-migrate') flags.add('no-migrate');
    else if (a === '--help' || a === '-h') flags.add('help');
    else if (a === '--version' || a === '-V') flags.add('version');
    else positional.push(a);
  }
  return { positional, flags };
}

export async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parse(argv);
  const ctx: Ctx = { json: flags.has('json'), verbose: flags.has('verbose') };
  const cmd = positional[0];

  if (flags.has('version') || cmd === 'version') {
    console.log(ctx.json ? JSON.stringify({ version: VERSION }) : VERSION);
    return;
  }

  if (!cmd || flags.has('help')) {
    console.log(HELP);
    return;
  }

  switch (cmd) {
    case 'id':
      return cmdId(ctx);
    case 'is-worktree':
      return cmdIsWorktree(ctx);
    case 'get':
      return cmdGet(ctx, positional[1] ?? '', positional[2] ?? '', positional[3]);
    case 'env':
      return cmdEnv(ctx, positional.slice(1));
    case 'up':
      return cmdUp(ctx, { seed: flags.has('seed'), noMigrate: flags.has('no-migrate') });
    case 'verify':
      return cmdVerify(ctx);
    case 'down':
      return cmdDown(ctx);
    case 'destroy':
      return cmdDestroy(ctx, { force: flags.has('force') });
    case 'session':
      return cmdSession(ctx);
    case 'status':
      return cmdStatus(ctx);
    case 'list':
    case 'ls':
      return cmdList(ctx);
    case 'doctor':
      return cmdDoctor(ctx);
    case 'init':
      return cmdInit(ctx);
    default:
      console.error(`penv: unknown command "${cmd}"\n`);
      console.log(HELP);
      process.exit(2);
  }
}
