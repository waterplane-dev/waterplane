/**
 * The backlog's verbs on rows: add, fire, edit, and the two reorders. Split out
 * of `BacklogManager` (move only): the methods are functions over `BacklogCore`.
 */
import { randomUUID } from "node:crypto";
import type { BacklogItem, BudgetPass, BudgetWaiver, Intent, IntentPatch, ItemCategory, LaunchOpts, SessionBudget } from "@waterplane/shared";
import { backlogDraft, intentToBacklogItem } from "../intents/adapters.js";
import type { BacklogCore } from "./backlogcore.js";
import { backlogRows } from "./backlogstore.js";

/**
 * `opts.steps` is the WHOLE chain and `steps[0]` repeats `text` — ONE item
 * delivered a turn at a time, rather than the N separate items the sheet used
 * to post for a chain. Absent is the one-turn item this verb has always made.
 * `opts.resume` opens that item's session with `claude --continue`.
 *
 * `opts.holdForHost` is for the one caller that is not a person: the
 * schedule's *add a backlog item* action, passing on the *wait until it's
 * free* tick that was set on the rule (`backlogDraft`, F14). Nothing a person
 * taps sets it.
 */
export function add(c: BacklogCore, text: string, repoDir: string, label?: string, targetSessionId?: string, autoFire?: boolean,
  opts?: { steps?: readonly string[]; resume?: boolean; closeWhenDone?: boolean; flagWhenDone?: boolean; budget?: SessionBudget; launch?: LaunchOpts; holdForHost?: boolean; pastBudget?: BudgetWaiver; budgetPass?: BudgetPass; origin?: string; id?: string; manual?: boolean }): BacklogItem {
  const now = Date.now();
  const orders = backlogRows(c).filter((i) => i.cwd === repoDir).map((i) => i.order ?? i.createdAt);
  // Newest on top (a smaller `order` than everything in this repo), EXCEPT an
  // item queued for a particular session: those build a run-in-order queue and
  // append to the bottom, so they run in the order they were added.
  const order = !orders.length ? now
    : autoFire ? Math.max(...orders) + 1
      : Math.min(...orders) - 1;
  const draft = backlogDraft({
    // A caller-minted id (the agent route's `agent-<key>`) makes the add
    // at-most-once in the STORE: `post()` answers an id it holds with that row.
    id: opts?.id ?? randomUUID().slice(0, 8), cwd: repoDir, text, label, targetSessionId, autoFire, order,
    steps: opts?.steps, resume: opts?.resume, closeWhenDone: opts?.closeWhenDone, flagWhenDone: opts?.flagWhenDone, budget: opts?.budget, launch: opts?.launch, holdForHost: opts?.holdForHost,
    pastBudget: opts?.pastBudget, budgetPass: opts?.budgetPass,
  });
  // What put this row here, when it was not a person. The only caller that
  // passes one today is the schedule's `workItem` executor
  // (`scheduleItemOrigin`), and it is what widens the rule ↔ item link from
  // "the last item per rule" (all `lastResult.childId` can carry) to every
  // item the rule ever wrote.
  const posted = c.intents.post({
    ...draft,
    ...(opts?.origin ? { origin: opts.origin } : {}),
    // Waits for a tap — an agent's add (`Intent.manual`).
    ...(opts?.manual ? { manual: true } : {}),
  }, now);
  const row = posted.intent;
  return row ? intentToBacklogItem(row, c.reviews.get(row.id)) : {
    id: draft.id, text, status: "failed", repoDir, label, createdAt: now, order,
    error: posted.reason || "could not be written down",
  };
}

/** Fire it now, whatever the ladder says — a person tapped it. Re-fires a
 *  settled item by returning it to the queue first. */
export async function fire(c: BacklogCore, id: string): Promise<void> {
  const row = c.intents.get(id);
  if (!row) return;
  if (row.state === "starting" || row.state === "running") return;
  // `allowDone` because this button is the one place "run it again" is meant
  // about work that RAN — which is what `requeueFailed` refuses in words, and
  // what the bare `requeue()` now refuses too. The re-queue leaves a history
  // entry (`Intent.requeues`) carrying the result this run is about to
  // overwrite, so a row that has been re-fired four times says so.
  //
  // `by: "run"` and not `"hand"`, because the next line fires it: the entry is
  // only the first half of running it now, and a row whose history said `hand`
  // would be claiming somebody put it back to wait its turn — which is a
  // different tap, on a different button, that this one is not.
  if (row.state === "done" || row.state === "failed" || row.state === "canceled") {
    c.intents.requeue(id, { allowDone: true, by: "run" });
  }
  await c.intents.runNow(id);
}

/** What `BacklogManager.update` may carry. */
export type BacklogUpdatePatch = {
  text?: string; label?: string; repoDir?: string; targetSessionId?: string; autoFire?: boolean; resume?: boolean;
  /** The per-item close-when-done override; `null` = follow the global. Lands
   *  through `edit()` like the name: not an edit to the work, so it never
   *  re-queues the row and is allowed while it runs. */
  closeWhenDone?: boolean | null;
  /** Flag the session for follow up when done: `true` sets, `false`/`null` clears. Through `edit()` like closeWhenDone. */
  flagWhenDone?: boolean | null;
  /** The cap the session this row opens is born with: `null` clears. Already cleaned (`cleanSessionBudget`) — never the raw wire shape. Queued/blocked rows only. */
  budget?: SessionBudget | null;
  /** A title a person typed, or `""` to clear it. `edit()`'s field and
   *  `edit()`'s rules — see there for what clearing means. */
  headline?: string;
  category?: ItemCategory | "";
};

/**
 * Edit a queued/failed/done item. The words, the label, the repo and the
 * session it is aimed at — none of which may change while it is in flight,
 * which is the store's rule and not a second one here.
 *
 * `autoFire` is the fifth field and the one that is not an edit of the words:
 * it is `add`'s per-item switch, applied to an item that already exists. That
 * is the whole of "queue this one here" — the phone has an item on screen and
 * a session open, and the tap means *aim it there and run it when that session
 * is next free*, without touching the global auto switch that routes machinery.
 *
 * Setting it to `true` also moves the row to the BOTTOM of its repo's queue,
 * exactly as `add` does for the same flag and for the same reason: the taps
 * ARE the order. Three items tapped in sequence run in that sequence, and a
 * row that kept a month-old `order` would jump the queue it was just added to.
 * Clearing it (`false`) moves nothing — un-queueing is not a re-ordering.
 */
export function update(c: BacklogCore, id: string, patch: BacklogUpdatePatch): { refused?: string } {
  const row = c.intents.get(id);
  if (!row) return {};
  /**
   * **The name goes through `edit()`, whatever else this patch carries.**
   *
   * `label`'s path, for `label`'s reason and one stronger one: `update()`
   * below returns the row to `queued`, which is right for an edit to the
   * WORDS and wrong for an edit to what the row is called. A person
   * re-titling a row that failed last night must not thereby put it back in
   * the queue — they renamed it, they did not ask for it to run.
   */
  const names = {
    ...(patch.headline === undefined ? {} : { headline: patch.headline }),
    ...(patch.category === undefined ? {} : { category: patch.category }),
  };
  if (patch.closeWhenDone === true || patch.closeWhenDone === false || patch.closeWhenDone === null) {
    c.intents.edit(id, { closeWhenDone: patch.closeWhenDone });
  }
  if (patch.flagWhenDone === true || patch.flagWhenDone === false || patch.flagWhenDone === null) {
    c.intents.edit(id, { flagWhenDone: patch.flagWhenDone });
  }
  // Through `edit()` like the flag, but its refusal (a row that already started) is SAID.
  const budgetRefused = patch.budget === undefined ? undefined : c.intents.edit(id, { budget: patch.budget }).refused;
  // The half a person typed that this app would not write is carried back to
  // the caller so it can be SAID. It is not an error and it stops nothing —
  // the rest of this patch lands exactly as it would have — but a title that
  // is dropped without a sentence is typed words lost in silence, which is
  // the one thing `edit()` must never do.
  const nameRefused = Object.keys(names).length ? c.intents.edit(id, names).refused : undefined;
  const refused = [nameRefused, budgetRefused].filter((s): s is string => !!s).join(" · ") || undefined;
  const said = (): { refused?: string } => (refused ? { refused } : {});

  // What is left once the name is dealt with. A patch that named nothing else
  // is FINISHED here: falling through with every field undefined would hand
  // `update()` a patch that says nothing and requeue the row for saying it.
  const touchesWork = !!patch.text || !!patch.repoDir
    || patch.targetSessionId !== undefined || patch.autoFire !== undefined || patch.resume !== undefined;
  if (typeof patch.label === "string" && !touchesWork) {
    c.intents.edit(id, { label: patch.label });
    return said();
  }
  if (!touchesWork) return said();
  const cwd = patch.repoDir || row.cwd;
  const orders = backlogRows(c).filter((i) => i.cwd === cwd && i.id !== id).map((i) => i.order ?? i.createdAt);
  // Plain `IntentPatch`. It was typed one field wider here while `resume` was
  // a real `Intent` field the wire DTO had not grown, and a type widened at
  // the call site is a field with no owner — nothing documents it, nothing
  // else can find it, and the next surface that wants to edit the flag widens
  // the type a second time. `IntentPatch.resume` exists now and says all of
  // that where the field lives.
  //
  // **Every field here is a CONDITIONAL spread, and the two below are not the
  // exception — they were the only ones that had it right.** `update()`
  // spreads this patch over the row, so a key carrying `undefined` does not
  // say "leave it alone", it DELETES the row's value: `cwd: undefined` took
  // the checkout off the row, `cleanIntentRow` then found nothing runnable,
  // and the whole edit was refused. A text-only edit carries no `repoDir`, so
  // that was every edit the form could make except the one that happened to
  // change the words AND the repo — Save saved nothing, silently, and the
  // form showed the old row back.
  //
  // It survived because `IntentPatch`'s own contract — *absent leaves the
  // row's own value alone* — is TRUE over the wire and false in process:
  // `JSON.stringify` drops an undefined-valued key, so `intent.update`
  // (*drop the clock*, the schedule sheet) never carried one and never hit
  // c. The direct call is the seam. `update()` now strips them as well,
  // so the two callers cannot behave differently again.
  const out: IntentPatch = {
    ...(typeof patch.text === "string" && patch.text.trim()
      ? { payload: { kind: "prompt", steps: [patch.text] } as const } : {}),
    ...(typeof patch.label === "string" ? { label: patch.label } : {}),
    ...(patch.repoDir ? { cwd: patch.repoDir } : {}),
    // "" clears the target → back to a session of the item's own
    // (`cleanTarget` normalises a bare `repo` to `fresh: true`).
    ...(patch.targetSessionId === undefined ? {}
      : { target: patch.targetSessionId ? { kind: "session", sessionId: patch.targetSessionId } as const : { kind: "repo" } as const }),
    // Only ever present when the caller said something about it — same rule as
    // `autoFire` below, and the reason `false` is meaningful here: it is the
    // only way to say "start clean after all" once the chip has been on.
    ...(patch.resume === undefined ? {} : { resume: patch.resume || undefined }),
    // Only ever present when the caller said something about it: the patch is
    // spread over the row, so a bare `pinned: undefined` would CLEAR a flag
    // nobody asked about.
    ...(patch.autoFire === undefined ? {} : { pinned: patch.autoFire || undefined }),
    ...(patch.autoFire === true && orders.length ? { order: Math.max(...orders) + 1 } : {}),
  };
  // **A refused edit is SAID.** `intents.update()` answers `{ok:false}` for a
  // row that has already settled — and a `failed` row aimed at a session that
  // closed is exactly the row this sheet's own notes tell a person to edit
  // ("pick another session, or take the aim off"). Dropping that verdict on
  // the floor closed the phone's editor over words that never landed, which
  // is the silence `edit()` refuses one field along. It is still not an
  // error: the name, if this patch carried one, has already been written.
  const res = c.intents.update(id, out);
  const work = res.ok ? undefined : (res.reason ?? "that edit did not land");
  if (!work) return said();
  return { refused: refused ? `${refused}; ${work}` : work };
}

/** Swap two items' positions (the client's one-step reorder). */
export function swap(c: BacklogCore, idA: string, idB: string): void {
  const a = c.intents.get(idA);
  const b = c.intents.get(idB);
  if (!a || !b || a === b) return;
  const oa = a.order ?? a.createdAt;
  const ob = b.order ?? b.createdAt;
  c.intents.edit(idA, { order: ob, handOrdered: true });
  c.intents.edit(idB, { order: oa, handOrdered: true });
}

/** The two store verbs `reorder` needs — narrow so the assessment's approved
 *  slot order (`assess/hassapply.ts`) is the drag's own verb, not a copy. */
export interface OrderStore {
  get(id: string): Intent | undefined;
  edit(id: string, patch: { order: number; handOrdered: true }): unknown;
}

/**
 * Apply an explicit top-to-bottom order to the LISTED rows (a drag, or an
 * agent asked to by the person). The listed rows trade their own slots — the
 * sorted set of their `order ?? createdAt` — so a row that is not listed keeps
 * its seat relative to all of them. That is what makes a drag inside a
 * filtered cut (the *on a clock* group, a search) safe: it used to renumber
 * the subset 0..n, which seated it ahead of every row off screen, so a drag
 * was refused whenever anything was filtered — exactly where seven items on
 * one reset are gathered to be put in order. Given the whole list, the result
 * is the old one.
 */
export function reorder(c: { intents: OrderStore }, ids: string[]): void {
  const rows = [...new Set(ids)].map((id) => c.intents.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
  const slots = rows.map((r) => r.order ?? r.createdAt).sort((a, b) => a - b);
  // Two rows on one slot would leave their order to the sort's stability.
  for (let i = 1; i < slots.length; i++) if (slots[i] <= slots[i - 1]) slots[i] = slots[i - 1] + 0.001;
  // Every id in the list, not just the one that moved: the client sends the
  // whole display order, and a person who dragged one row past four others
  // has placed all five — the four are where they are BECAUSE that drag put
  // them there, and marking only the moved row would leave the rest free for
  // an automatic sort to shuffle back under it.
  rows.forEach((r, i) => c.intents.edit(r.id, { order: slots[i], handOrdered: true }));
}

