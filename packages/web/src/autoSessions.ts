/**
 * **Automatic sessions** — the ones a fired backlog or scheduled item opens
 * (`backlog · <repo> · <label>`) — as the phone words them: whether one closes
 * itself once its work is done, and which of them hold the slots a waiting row
 * needs.
 *
 * Pure, node-tested (`autoSessions.test.mjs`). The decision itself is the
 * host's (`closeWhenDoneOf`, `autoSlotsWaitText` in `@waterplane/shared`); what is
 * here is the three-way choice a person makes about one row and the list a
 * `noSlot` wait offers to make room from.
 *
 * **Absent is INHERIT, never off.** `BacklogItem.closeWhenDone` absent follows
 * the global setting, and the global is shown beside the choice that follows
 * it ("as set globally (currently: keep open)") — a row reading "keep open"
 * when it merely inherits would flip silently the day the global is switched.
 *
 * **Nothing here closes anything.** Closing is the ordinary session close, a
 * person's tap (`nav.closeSession`). A count on the control that offers it is
 * the list it opens: exactly the sessions `autoSlotSessions` returns.
 */
import type { AutoSlotFacts, SessionInfo } from "@waterplane/shared";

/** The three answers a row can carry. `inherit` is the absent field. */
export type CloseChoice = "inherit" | "keep" | "close";

export const CLOSE_CHOICES: readonly CloseChoice[] = ["inherit", "keep", "close"];

/** The row's stored value as a choice — `undefined` is `inherit`, never `keep`. */
export function closeChoiceOf(v: boolean | undefined | null): CloseChoice {
  return v === true ? "close" : v === false ? "keep" : "inherit";
}

/** The choice as `backlog.update` carries it: `null` CLEARS back to inherit. */
export function closeChoicePatch(c: CloseChoice): boolean | null {
  return c === "close" ? true : c === "keep" ? false : null;
}

/** The choice as `backlog.add`/a schedule action carries it: inherit sends NOTHING. */
export function closeChoiceDraft(c: CloseChoice): boolean | undefined {
  return c === "close" ? true : c === "keep" ? false : undefined;
}

/** What the global setting does, in the two words the chips use. */
export const globalCloseWords = (global: boolean): string => (global ? "close when done" : "keep open");

/** One chip's label. The inherit chip says what inheriting means TODAY. */
export function closeChoiceLabel(c: CloseChoice, global: boolean): string {
  if (c === "close") return "close when done";
  if (c === "keep") return "keep open";
  return `as set globally (currently: ${globalCloseWords(global)})`;
}

/**
 * The row's EFFECTIVE answer as a sentence, with whose answer it is — drawn
 * above the chips so the decision on screen is read before it is changed.
 */
export function closeEffectWords(v: boolean | undefined | null, global: boolean): string {
  const c = closeChoiceOf(v);
  const closes = c === "inherit" ? global : c === "close";
  const what = closes
    ? "Its session closes itself once the work is done (it stays under Recently closed, reopenable)"
    : "Its session stays open once the work is done, until you close it";
  return `${what} — ${c === "inherit" ? "as set globally" : "this item's own choice"}.`;
}

/** The receipt for a tap on a chip. */
export function closeChoiceToast(c: CloseChoice, global: boolean): string {
  if (c === "inherit") return `follows the global setting — ${global ? "closes when done" : "stays open"}`;
  return c === "close" ? "its session will close when done" : "its session will stay open";
}

/**
 * The short chip on a CLOSED row — only for an item's own answer. A row that
 * inherits says nothing on the closed line: fifty copies of the global
 * setting is not information, and the open row says it in full.
 */
export function closeChipWords(v: boolean | undefined | null): string | null {
  const c = closeChoiceOf(v);
  return c === "close" ? "closes when done" : c === "keep" ? "stays open" : null;
}

/**
 * Does this row open a session of its own, so the question means anything? A
 * row aimed at a session that already existed opened nothing — read off
 * `targetSessionId`, the field the group heads read.
 */
export const opensOwnSession = (it: { targetSessionId?: string }): boolean => !it.targetSessionId;

/**
 * **Is this row held because every automatic slot is taken?** The host's own
 * facts (`autoSlots` full) AND the row's own wait sentence naming a slot — the
 * sentence is what says THIS row is the one held on it, the facts say a slot
 * is what would free it.
 */
export function slotHeld(wait: string | undefined | null, slots: AutoSlotFacts | null | undefined): boolean {
  if (!wait || !slots) return false;
  return slots.open.length >= slots.max && /free slot/i.test(wait);
}

export interface AutoSlotSession {
  s: SessionInfo;
  /** Whether this one will close itself once it has lingered. */
  closeWhenDone: boolean;
}

/**
 * The open automatic sessions a person could close to make room: the host's
 * snapshot (oldest first) INTERSECTED with the live session list, so a session
 * closed since the snapshot is never offered. The order is the host's.
 */
export function autoSlotSessions(slots: AutoSlotFacts | null | undefined, sessions: readonly SessionInfo[]): AutoSlotSession[] {
  if (!slots) return [];
  const live = new Map(sessions.map((s) => [s.id, s]));
  const out: AutoSlotSession[] = [];
  for (const o of slots.open) {
    const s = live.get(o.id);
    if (s && s.running) out.push({ s, closeWhenDone: o.closeWhenDone });
  }
  return out;
}

/** The control's label — its count IS the list it opens. */
export function closeOneLabel(n: number): string {
  return `close one to make room — ${n} open`;
}

/** What a slot session is doing, in words: the row's second line. */
export function slotSessionState(s: SessionInfo, closeWhenDone: boolean): string {
  const doing = s.turnActive ? "working" : "idle";
  return closeWhenDone ? `${doing} · closes itself when done` : `${doing} · stays open until closed`;
}
