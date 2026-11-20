/**
 * A row the background relay already wrote, as the queue UI must treat it. Pure: no store, so a
 * feature (`features/<x>`, which may not value-import `outbox`) and the queue core share ONE rule.
 */
import type { OutboxEntry } from "./outbox";
import { hostSaidNotRun } from "./core/queue/phase.ts";

type RelayedFacts = Pick<OutboxEntry, "relayedAt" | "status" | "failState" | "reason">;

export { hostSaidNotRun };

/**
 * Did the background relay put this row on the wire, with no host word that it never ran?
 * Then the prompt may already have run: editing, discarding, putting back or
 * rewriting it would claim a cancel that never happened, or run it twice under a
 * new ackId. A `failed` row is NOT enough to unlock it: a relayed row can fail on a
 * local give-up while its words run on the desktop. Only `hostSaidNotRun` frees it;
 * unknown stays LOCKED (`relayedAt` stays on the row either way).
 */
export function isRelayedLive(e: RelayedFacts): boolean {
  return e.relayedAt != null && !hostSaidNotRun(e);
}

/**
 * A relayed row that FAILED with no host word that it never ran: locked for good (`isRelayedLive`
 * stays true), and nothing will ever take it out of the queue on its own — no receipt is coming.
 * Its one way out is "remove from the list" (`removeRelayedStuck`): a local removal that cancels
 * nothing and sends nothing. Rewrite, put back and a fresh-ackId send stay refused.
 */
export function isRelayedStuck(e: RelayedFacts): boolean {
  return e.relayedAt != null && e.status === "failed" && !hostSaidNotRun(e);
}

/** The way out's label, on the row that draws it and in every sentence that names it. */
export const RELAYED_REMOVE_LABEL = "remove from the list";

/** Why a LIVE relayed row's buttons say no (pending or queued: a receipt is still coming). */
export const RELAYED_WHY = "the background link already sent it — the desktop may be running it; it leaves the queue when it confirms";

/** Why a STUCK relayed row's buttons say no: no receipt is coming, so "it leaves when…" would be false. */
export const RELAYED_STUCK_WHY = `the background link sent it and the desktop never said whether it ran — it may have, so its words stay as they are; “${RELAYED_REMOVE_LABEL}” clears it`;

/** The sentence for this row's refusal, live or stuck. */
export function relayedWhy(e: RelayedFacts): string {
  return isRelayedStuck(e) ? RELAYED_STUCK_WHY : RELAYED_WHY;
}

/** The one sentence for a verb a relayed row refuses ("edited", "discarded", "rewritten"…). Pass the
 *  row: a stuck one never leaves the queue by itself, so it is told the way out instead. */
export function relayedRefusal(what: string, e?: RelayedFacts): string {
  return e && isRelayedStuck(e)
    ? `the background link sent it and the desktop never said whether it ran — it can't be ${what}; “${RELAYED_REMOVE_LABEL}” on its row clears it`
    : `the background link already sent it — it can't be ${what}; it leaves the queue when the desktop confirms`;
}

/** The question before the way out (`Confirm.tsx`'s `askConfirm`). Says the words may have run, that
 *  nothing is canceled or sent, and that the words leave with the row. */
export interface RemoveAsk { title: string; lines: string[]; confirmLabel: string }
export const RELAYED_REMOVE_ASK: RemoveAsk = {
  title: "Remove it from the list?",
  lines: [
    "The background link sent it, and the desktop never said whether it ran — it may have.",
    "Removing it cancels nothing and sends nothing; its words leave this list with it. Open the session to see what happened.",
  ],
  confirmLabel: RELAYED_REMOVE_LABEL,
};

/** The receipt once it went. Never "discarded": that would claim a cancel. */
export const RELAYED_REMOVED = "removed from the list — nothing was canceled; it may have run on the desktop";

/**
 * The way out for a stuck relayed row: ask, then remove locally. `remove` is the queue's
 * `removeQueued(ackId, { mayHaveRun: true })`, which unlocks a STUCK row only — never a live one.
 * Nothing here sends: no frame, no new ackId. `kept` = the person said no (the dialog closing is the
 * visible result); `refused` = not stuck, or the queue said no (it said why).
 */
export async function removeRelayedStuck(
  e: RelayedFacts & Pick<OutboxEntry, "ackId">,
  deps: {
    ask: (q: RemoveAsk) => Promise<boolean>;
    remove: (ackId: string) => boolean;
    toast: (s: string) => void;
  },
): Promise<"removed" | "kept" | "refused"> {
  if (!isRelayedStuck(e)) return "refused";
  if (!(await deps.ask(RELAYED_REMOVE_ASK))) return "kept";
  if (!deps.remove(e.ackId)) return "refused";
  deps.toast(RELAYED_REMOVED);
  return "removed";
}

/** ackIds whose row left the queue because the DESKTOP confirmed it (a receipt, a claim's receipt,
 *  `landed`). Bounded: a sheet only ever asks about the row it was opened on. */
const confirmedAcks = new Set<string>();
const CONFIRMED_CAP = 200;

/** Record that the desktop's receipt, not a local verb, took this row out of the queue. */
export function noteReceiptRemoval(ackId: string | undefined): void {
  if (!ackId) return;
  confirmedAcks.add(ackId);
  if (confirmedAcks.size > CONFIRMED_CAP) confirmedAcks.delete(confirmedAcks.values().next().value as string);
}

/**
 * A Send sheet opened ON a queue row (`seed.ackId`) whose row left the queue BECAUSE THE DESKTOP
 * CONFIRMED IT (the background link's receipt, or the page's own re-send, `noteReceiptRemoval`).
 * Posting the sheet's words would run them again under a new ackId, so the sheet refuses in words
 * and keeps them. A row a local verb removed (Dismiss, cancel from the main pane while a wide
 * window's Send panel is open) proves nothing ran, so it does NOT count: the words may go.
 */
export function seedRowGone(seedAckId: string | undefined, outbox: readonly Pick<OutboxEntry, "ackId">[]): boolean {
  return !!seedAckId && confirmedAcks.has(seedAckId) && !outbox.some((e) => e.ackId === seedAckId);
}

/** Why Send refuses (and Discard has nothing to discard) once the row this sheet came from is gone. */
export const SEED_ROW_GONE_WHY = "the message this came from was already confirmed by the desktop — it has it, so sending these words again would run them twice; close this sheet";

/** Discard on such a sheet: the words are cleared, but the prompt was not canceled — it ran. */
export const SEED_ROW_GONE_DISCARD = "the message this came from had already left the queue — the desktop has it; nothing was canceled";

/**
 * Why a Send sheet opened on a queue row (`seedAckId`) must NOT post its words under a new ackId, or
 * null when it may: the row was written by the background link (`isRelayedLive`), or it left the
 * queue because the desktop confirmed it (`seedRowGone`). `useSend`'s `dispatchIntent` asks this
 * before any send arm runs, so a refusal keeps the words in the sheet.
 */
export function seedRewriteRefusal(seedAckId: string | undefined, outbox: readonly (RelayedFacts & Pick<OutboxEntry, "ackId">)[]): string | null {
  if (!seedAckId) return null;
  const replaced = outbox.find((e) => e.ackId === seedAckId);
  if (replaced && isRelayedLive(replaced)) return relayedRefusal("rewritten", replaced);
  if (seedRowGone(seedAckId, outbox)) return SEED_ROW_GONE_WHY;
  return null;
}

/**
 * Discard on a Send sheet opened on a queue row. `gone`: the desktop confirmed it — nothing to
 * remove, and "discarded" would claim a cancel of a prompt that ran. `refused`: the queue's own
 * verb said no (a row the background link wrote) — the sheet stays and the caller says nothing
 * more. `removed`: the row went. `none`: the sheet was not opened on a row.
 */
export function seedDiscard(
  seedAckId: string | undefined,
  outbox: readonly Pick<OutboxEntry, "ackId">[],
  removeQueued: (ackId: string) => boolean,
): "none" | "gone" | "refused" | "removed" {
  if (!seedAckId) return "none";
  if (seedRowGone(seedAckId, outbox)) return "gone";
  return removeQueued(seedAckId) ? "removed" : "refused";
}
