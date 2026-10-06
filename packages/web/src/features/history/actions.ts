/**
 * Every writer of the history store, and what the sheet sends.
 */
import type { HistoryEntry } from "@waterplane/shared";
import { core, mapWith } from "../../sdk";
import { saveHistoryEntries } from "../../offlineCache";
import { pinToast } from "./logic";
import { history } from "./store";

/** A `session.history` frame's entries: kept, and cached (output stripped) so
 *  the sheet still has this session's prompts offline — see offlineCache.ts
 *  for why output can't ride along. */
export function noteHistory(sessionId: string, entries: HistoryEntry[]): void {
  history.set((prev) => mapWith(prev, sessionId, entries));
  saveHistoryEntries(sessionId, entries);
}

/** Drop a past prompt back into the composer — appended, never over the draft. */
export function resendToCompose(text: string): void {
  const c = core();
  c.compose.insert(text);
  c.nav.close("history");
  c.say.toast("dropped into composer");
}

/** Pin (or unpin, null) an entry as the session's overview label. */
export function pinEntry(sessionId: string, entryId: string | null): void {
  const c = core();
  c.say.track("action:session.pin");
  c.conn.send({ t: "session.pin", id: sessionId, entryId });
  c.say.toast(pinToast(entryId));
}
