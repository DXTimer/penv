export interface Ctx {
  json: boolean;
  verbose: boolean;
}

/** Emit structured data (only in --json mode). */
export function emit(ctx: Ctx, data: unknown): void {
  if (ctx.json) console.log(JSON.stringify(data));
}

/** Human-readable line (suppressed in --json mode). */
export function say(ctx: Ctx, msg: string): void {
  if (!ctx.json) console.log(msg);
}

/** Diagnostic line to stderr (always shown; never pollutes stdout JSON). */
export function note(ctx: Ctx, msg: string): void {
  if (ctx.verbose || !ctx.json) console.error(msg);
}

export function fail(ctx: Ctx, msg: string, code = 'PENV_ERROR', extra?: Record<string, unknown>): never {
  if (ctx.json) {
    console.log(JSON.stringify({ error: msg, code, ...(extra ?? {}) }));
  } else {
    console.error(`penv: ${msg}`);
  }
  process.exit(1);
}
