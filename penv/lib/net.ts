/**
 * Port availability probe. Binding 127.0.0.1:<port> fails if anything holds
 * that port (whether bound to loopback or 0.0.0.0), so a successful bind is a
 * reliable "free" signal. Combined with the ledger scan in alloc.ts this
 * catches both OS-level and not-yet-bound (reserved) collisions.
 */
export function portFree(port: number): boolean {
  try {
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}
