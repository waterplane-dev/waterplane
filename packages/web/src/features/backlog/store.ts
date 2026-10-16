/**
 * What the backlog feature holds — the backlog and its grooming (the
 * assessment) — and their read hooks. One writer: `actions.ts`, called by the
 * handlers in `index.ts`, the sheets and App's `op.ack` (`onAssessAck`).
 */
import type { AssessRun, AssessScope, AutoSlotFacts, BacklogItem, RepoTarget } from "@waterplane/shared";
import { createStore, useStore } from "../../sdk";
import { LS } from "../../storage";
import { loadSnap } from "../../localState";

/**
 * The host's `backlog.list`, as ONE value so a frame lands in one emit.
 *
 * `items`, `auto` and `snapAt` are **seeded from the
 * last-synced snapshot** (`waterplane.snap.backlog`, written on every live list) so
 * the sheet renders offline instead of empty — mutations are then refused in
 * words until the socket reopens (`Backlog.tsx`'s `online`).
 *
 * `waiting` and `naming` are deliberately NOT snapshotted: each describes this
 * second (why an item isn't running, which rows a naming pass holds), so a
 * copy read back offline would state something that ended an hour ago. The
 * sheet reads them only while online.
 *
 * `snapAt` is when that snapshot was written — the age label offline. (An older
 * snapshot may still carry `smartPick`/`passes`, the removed smart pick's
 * fields; they are not read.)
 */
export interface BacklogState {
  items: BacklogItem[];
  auto: boolean;
  waiting: Record<string, string>;
  naming: string[];
  /** The automatic-session cap as the host's facts — what a `noSlot` row's
   *  *close one to make room* lists. A fact about THIS second, so never
   *  snapshotted (`waiting`'s reason); null from a host that predates it. */
  autoSlots: AutoSlotFacts | null;
  snapAt: number | null;
}

function seed(): BacklogState {
  const snap = loadSnap<{ items?: BacklogItem[]; auto?: boolean; at?: number }>(LS.snapBacklog, {});
  return {
    items: snap.items ?? [],
    auto: snap.auto ?? false,
    waiting: {},
    naming: [],
    autoSlots: null,
    snapAt: snap.at ?? null,
  };
}

export const backlog = createStore<BacklogState>(seed());

/**
 * Which repo the backlog sheet opens on when it was reached from the launcher
 * (or a session) rather than by its own preference order. Null ⇒ the sheet's
 * own choice (last used, then a repo with items) is left alone.
 */
export const backlogScope = createStore<string | null>(null);
/** The ids cut the sheet was OPENED on — a schedule card's "1 item", a groomed
 *  notification's rows. A filter is what the TAP asked for and never a
 *  setting, so leaving the sheet drops it (`onLeave`). A FRESH object per open:
 *  `Backlog` re-applies on identity. */
export const backlogFocus = createStore<{ ids: string[]; label: string } | null>(null);

/**
 * Each repo's newest assessment run, keyed by worktree path. Host-held and
 * pushed on every state change (`assess.state`), never derived here, and not
 * persisted — a proposal is a diff waiting for a person, and a stale copy is
 * the one thing that screen must never show.
 */
export const assessRuns = createStore<ReadonlyMap<string, AssessRun>>(new Map());
/** The repo an open assessment sheet is about. Cleared only by the sheet's own
 *  close — a route OVER it (the plan, the backlog cut) must come back to it. */
export const assessRepo = createStore<RepoTarget | null>(null);
/** The cut the sheet was opened WITH (the backlog's filtered rows), or null for
 *  the whole repo — held because *run again* has to carry it. Cleared with the
 *  sheet: a scope is the tap, not a setting. */
export const assessScope = createStore<string[] | null>(null);
/** **What `assessScope`'s ids ARE**, when the sheet was opened by a slot check
 *  (the backlog's *check these N*, the ask after a timed send) — so *run
 *  again* is a slot check too. Cleared with the sheet, with `assessScope`. */
export const assessSlot = createStore<AssessScope | null>(null);
/**
 * Assess ops sent and not yet acked, and **what this phone still owes the pad
 * if one comes back `ok`** (ackId → pad note ids).
 *
 * **Ref-authoritative**, the queue's rule for the queue's reason: `onAssessAck`
 * runs inside a socket subscription, and what this map guards is a DELETE of
 * somebody's words, so it does not get to be a render behind. A store's `get()`
 * is synchronous — it IS the ref — and `noteAssessOp`/`onAssessAck` are its
 * only writers; the sheet's `busy` is the same value, subscribed.
 */
export const assessBusy = createStore<ReadonlyMap<string, string[]>>(new Map());

/** The backlog as the host last said it — App's compose strip, the launcher's
 *  badges and the fire-nav read it through this. */
export function useBacklog(): BacklogState {
  return useStore(backlog);
}
