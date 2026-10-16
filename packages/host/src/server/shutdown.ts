/**
 * The process-level handlers: the SIGTERM/SIGINT flush, `unhandledRejection`,
 * `uncaughtException`.
 *
 * Moved verbatim out of `main.ts` (M6 of the host split, see
 * docs/notes/host-architecture.md). The FLUSH ORDER below is behaviour — keep
 * it. Every store is read as `ctx.<name>` when the signal arrives, not when the
 * handlers are installed.
 */
import type { ServerCtx } from "./ctx.js";
import { logTag } from "@waterplane/shared";

export function installShutdown(ctx: ServerCtx): void {
  /**
   * Flush the ack ledger before we go.
   *
   * `npm run restart` is `launchctl kickstart -k` — an immediate SIGTERM — and the
   * ledger's low-frequency writes are debounced on an UNREF'd timer, so without
   * this the last few hundred milliseconds of receipts die with the process. That
   * is precisely the window that matters: the phone fires a 12-repo `fanout.run`,
   * the host starts it, the socket drops before `op.ack` lands, a restart happens
   * — and a forgotten verdict turns the client's retry into a second sweep.
   *
   * Op verdicts are already written synchronously (acks.ts), so this covers the
   * debounced `input.ack` records and any op whose sync write raced the signal.
   * Exit behaviour is otherwise unchanged: node's default for both signals is to
   * terminate, so we terminate — installing a handler suppresses that default, and
   * a daemon that ignores SIGTERM would make `npm run restart` hang.
   */
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      try { ctx.acks.flush(); } catch { /* shutdown must never throw */ }
      // Debounced ~2 s, and `npm run restart` is routine — without this the last
      // observations before every restart die with the process, which for a record
      // whose whole job is to notice a slow drift is the wrong seconds to lose.
      try { ctx.cliHealthStore.flush(); } catch { /* shutdown must never throw */ }
      try { ctx.sentLogStore.flush(); } catch { /* shutdown must never throw */ }
      try { ctx.installLog.flush(); } catch { /* shutdown must never throw */ }
      try { ctx.netstats.flush(); } catch { /* shutdown must never throw */ }
      // The per-model context-window marks. Debounced ~3 s, and losing the one
      // that just moved means every context graph for that model draws on the
      // wrong axis until another long conversation re-earns it.
      try { ctx.sessions.flushContextWindows(); } catch { /* shutdown must never throw */ }
      try { ctx.tokenStats.flush(); } catch { /* shutdown must never throw */ }
      try { ctx.usageLog.flush(); } catch { /* shutdown must never throw */ }
      try { ctx.usageSources.flush(); } catch { /* shutdown must never throw */ }
      try { ctx.settings.flush(); } catch { /* shutdown must never throw */ }
      // Open questions are debounced nowhere — but a row created in the last
      // milliseconds before a restart is exactly the one whose answer nobody has
      // yet, so flush it with the rest.
      try { ctx.openDeliveries.flush(); } catch { /* shutdown must never throw */ }
      // Belt and braces: the intent store writes synchronously on every mutation
      // precisely so that `op.ack ok` means "on disk" with no exit hook involved.
      // A flush here can therefore never be load-bearing — and that is exactly why
      // it is safe to keep, and why `e2e-intent.mjs` uses `kill -9`, which would
      // skip it, rather than a signal this handler could paper over.
      try { ctx.intents.flush(); } catch { /* shutdown must never throw */ }
      // Every plugin stream ends first (cause "socket", nothing sent — the sockets go with the
      // process), so a producer hears `close` before its plugin's `deactivate()`.
      try { ctx.plugins.streams.endAll(); } catch { /* shutdown must never throw */ }
      // Plugins' `deactivate()` — started, never awaited: a plugin cannot hold
      // the exit, and anything it must keep it writes as it goes.
      try { ctx.plugins.deactivateAll(); } catch { /* shutdown must never throw */ }
      // Plugins' child processes go last, just before exit (`shutdown()`, synchronous —
      // opencode's per-session `serve` children): they own the session state on disk, so
      // nothing above may depend on them being alive.
      try { ctx.plugins.shutdownAll(); } catch { /* shutdown must never throw */ }
      process.exit(0);
    });
  }

  // A single bad request or dropped push must never take the daemon down.
  process.on("unhandledRejection", (err) => console.error(`${logTag} unhandledRejection`, err));
  process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
    // A port we can't bind is fatal, not swallowable — exit cleanly so we never
    // linger as a half-bound zombie (the thing that broke restarts).
    if (err?.code === "EADDRINUSE") {
      console.error(`${logTag} port ${ctx.PORT} already in use — exiting (run \`npm run restart\`).`);
      process.exit(1);
    }
    console.error(`${logTag} uncaughtException`, err);
  });
}
