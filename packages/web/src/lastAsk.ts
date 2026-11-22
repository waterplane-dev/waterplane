/**
 * **Which session an "ask the agent" button started last time** — the stored half (rules and
 * reasons: `lastAskLogic.ts`). One writer each: `noteAsk` when the Send sheet's send goes to a
 * session or mints a create, `noteAskAdopted` when that create's session id is known.
 */
import { createStore } from "./sdk/store.ts";
import { LS, lsJson, lsSetJson } from "./storage";
import { isPendingId, parsePendingId } from "./core/queue/pendingId.ts";
import { adoptAsks, recordAsk, type LastAsk, type LastAsks } from "./lastAskLogic.ts";

const load = (): LastAsks => {
  const v = lsJson<LastAsks>(LS.lastAsks, {});
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
};

/** The records, re-read on a host switch's reload; a component subscribes with `useStore`. */
export const lastAsks = createStore<LastAsks>(load());

function save(next: LastAsks): void {
  if (next === lastAsks.get()) return;
  lsSetJson(LS.lastAsks, next);
  lastAsks.set(next);
}

/** Remember where `key`'s send went: a session id, or a new session's create ackId. */
export function noteAsk(key: string, a: Omit<LastAsk, "at">): void {
  // A send aimed at a session still being created names it by its pending screen: keep the ack.
  const ack = a.sid ? parsePendingId(a.sid) : null;
  if (isPendingId(a.sid) && !ack) return; // `+ later`: no session stands behind it
  const rec: Omit<LastAsk, "at"> = ack ? { ack, cwd: a.cwd } : a;
  save(recordAsk(load(), key, { ...rec, at: Date.now() }));
}

/** A create became a session: fill it in on every record waiting on that ack. */
export function noteAskAdopted(ack: string, sid: string): void {
  save(adoptAsks(load(), ack, sid));
}
