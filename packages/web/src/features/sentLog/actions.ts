import type { SentCommand } from "@waterplane/shared";
import { core, type CoreApi } from "../../sdk";
import { mergeSent } from "./logic";
import { entries, scope } from "./store";

/**
 * Open the log, scoped to one session or (null) to all of them, asking the host
 * for a fresh copy. `liveAsk`, so a tap with the link down SAYS the question
 * could not be asked. The caller tracks and closes its own menu.
 */
export function openSentLog(sessionId: string | null): void {
  const c = core();
  scope.set(sessionId);
  c.conn.liveAsk(sessionId ? { t: "sent.get", sessionId } : { t: "sent.get" });
  c.nav.open("sentlog");
}

/** The toolbar's `sent`: the audit trail for THIS session — what was typed
 *  into it and by whom. */
export function openSentForActive(c: CoreApi): void {
  const active = c.world.active;
  if (!active) { c.say.toast("no active session"); return; }
  scope.set(active.id);
  c.conn.send({ t: "sent.get", sessionId: active.id });
  c.nav.open("sentlog");
}

/** `sent.new`: one row appended live, or a correction of one by id (`mergeSent`). */
export function onSentNew(entry: SentCommand): void {
  entries.set((prev) => mergeSent(prev, entry));
}
