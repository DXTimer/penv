import { main } from './cli.ts';

// Arg offset differs between modes:
//   dev (bun <entry> ...):  process.argv = [bun, <entry>, ...args]
//   compiled standalone:    process.argv = [exe, ...args]  (entry not present)
const entryIdx = process.argv.indexOf(Bun.main);
const args = process.argv.slice(entryIdx >= 0 ? entryIdx + 1 : 1);

main(args).catch((err) => {
  console.error(`penv: ${err?.message ?? err}`);
  process.exit(1);
});
