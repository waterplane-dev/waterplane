/**
 * The backlog — a VIEW of the intent store, plus the two things that are only
 * the backlog's.
 *
 * ── What used to be here ────────────────────────────────────────────────────
 *
 * A store (`<repoDir>/<state dir>/backlog.json`, written with a bare `writeFileSync`
 * and no tmp+rename), a 2 s tick, a lifecycle, a completion watcher, a
 * "why is this queued" narrator and a delivery path — 1,119 lines, five of
 * which the rest of this daemon had one copy of each anyway. `intents/` is that
 * store, that tick, that lifecycle and that watcher, once, for every subsystem.
 * The narrator is `intentVerdict`'s ladder, which is the same ladder that
 * decides — the property `waiting()` was written to have and could only
 * approximate while the two lived in different files.
 *
 * What is left is what could not move:
 *
 *   • **the sessions** — `openItemSession` opens ONE session per fired item,
 *     `autoSessionCount` says how many of those are WORKING (the cap the ladder's
 *     `noSlot` rung subtracts from — an idle one left open holds no slot) and
 *     `lingerSweep` closes the ones set to close when done once they have been
 *     sat on long enough to look at. `ensureRepoSession` /
 *     `resolveRepoSession` remain for the two things that still ask about a
 *     repo's session rather than an item's: the sheet's own button, and a hand
 *     fire on a row old enough to predate `fresh`.
 *   • **`deliverPrompt`, and the wording for when it fails** — `deliveryError`
 *     says three different things for three verdicts, and the middle one
 *     (`unsubmitted`: the text IS in the composer, one Return from running) must
 *     never read like "nothing happened".
 *   • **the DTO** — `backlog.*` is unchanged on the wire, so `list()` and
 *     `waiting()` render intents as `BacklogItem`s and every route below still
 *     calls the verbs it always called.
 *
 * The check/validate verbs went to `review.ts`: they are questions about work
 * that has already settled, not lifecycle, and they were a third of this file.
 *
 * ── Why every item now gets its OWN conversation ────────────────────────────
 *
 * There used to be ONE `backlog · <repo>` session per repo and every item that
 * repo ever queued was typed into it. It was recognised by its exact title, it
 * was never closed on purpose, and the note in `docs/notes/host.md` said out
 * loud that "nothing here auto-closes a session… which is what makes the next
 * item cheap". That sentence was wrong, and this repo already held the number
 * that proves it.
 *
 * `shared/sessioncost.ts` computes the break-even: every turn re-sends the whole
 * conversation, so a session sitting at k× its own baseline pays `k·base·R` per
 * turn for ever, while a fresh one pays one `base·W` and `base·R` after that.
 * The module’s own levels put the crossover at ~13 turns for a window at 2.5×,
 * ~5 at 5× and ~3 at 9×. A backlog session reaches 5× within a handful of items,
 * because each item reads ITS OWN files into the window and none of that helps
 * the next one. `CLAUDE.md` has the measurement from this desktop: 124
 * conversations out of 8,968 grew past 200k and were **76% of every token
 * spent**. A shared backlog session is exactly that shape, with nobody watching.
 *
 * So the default is a session per item, titled `backlog · <repo> · <label>`, and
 * the prefix — never the exact string — is what marks one. There is deliberately
 * no `/clear` in front of it: a fresh process IS the clear, and it also lands the
 * item as its own reopenable conversation in `archive.ts`, where a `/clear`
 * would have buried N items in one log with no boundary between them.
 *
 * A person who WANTS the shared context still has two ways to say so, and both
 * are a choice rather than a side effect of a title match: aim the row at a live
 * session (`{kind:"session"}`, the sheet's *queue here*), or ask for a new
 * session that picks up the repo's last conversation (`resume`, i.e.
 * `claude --continue`).
 */
import type { AutoSlotFacts, BacklogItem, BudgetPass, BudgetWaiver, Intent, LaunchOpts, SessionBudget } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import type { SessionManager } from "./sessions.js";
import type { IntentManager, ExecutorResult } from "./intents/manager.js";
import type { ReviewStore } from "./review.js";
import { intentToBacklogItem } from "./intents/adapters.js";
import { join } from "node:path";
import { DEFAULT_IDLE_MS } from "./backlog/backlogknobs.js";
import type { BacklogCore } from "./backlog/backlogcore.js";
import * as store from "./backlog/backlogstore.js";
import * as edits from "./backlog/backlogedits.js";
import type { BacklogUpdatePatch } from "./backlog/backlogedits.js";
import * as sess from "./backlog/backlogsessions.js";
import { followUpSweep } from "./backlog/backlogfollowup.js";

// The slices, re-exported so no importer changes (`backlog/backlog*.ts`).
export { BACKLOG_LINGER_MS, BACKLOG_SESSIONS_MAX, REAP_CEILING_MS } from "./backlog/backlogknobs.js";
export { chainDeliveryError, deliveryError, retryableStep } from "./backlog/backlogwording.js";
export { backlogTitle, isBacklogTitle, withoutBacklogMark } from "./backlog/backlogtitles.js";

export class BacklogManager {
  /** Everything the slices read and write — see `backlog/backlogcore.ts`. */
  private readonly core: BacklogCore;

  constructor(
    root: string,
    sessions: SessionManager,
    intents: IntentManager,
    reviews: ReviewStore,
    public idleMs = DEFAULT_IDLE_MS,
  ) {
    this.core = {
      root, sessions, intents, reviews,
      autoPath: join(hostStateDir(root), "backlog-config.json"),
      auto: false,
      repoSessions: new Map(),
      openedBy: new Map(),
      closeDefault: () => false,
    };
  }

  // ── Boot ────────────────────────────────────────────────────────────────

  /** Read the auto-fire switch, then fold every repo's old items file into the store. */
  init(): Promise<void> { return store.init(this.core); }

  // ── The list, as clients know it ────────────────────────────────────────

  /** Backlog rows, oldest position first — `order` IS the run order. */
  rows(): Intent[] { return store.backlogRows(this.core); }

  list(): BacklogItem[] {
    // The review verdicts (`review.ts`) are a sidecar merged at render, keyed by
    // intent id: a fact that outlives the run it describes does not belong on
    // the `Intent`, and the wire DTO still has to carry it on `BacklogItem`.
    return this.rows().map((i) => intentToBacklogItem(i, this.core.reviews.get(i.id)));
  }

  /**
   * Why each queued item is not running yet — the store's own sentence, not a
   * second reading of the same state.
   *
   * This used to be a hand-written ladder that had to be kept in step with
   * `tick()`'s, in a comment that said so. It is now literally the verdict the
   * tick acted on, recorded on the row when the words changed. A queued row with
   * no sentence is one nothing has objected to yet, which is the honest reading
   * of "about to run".
   */
  waiting(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const i of this.rows()) {
      if (i.archived) continue;
      if (i.state !== "queued" && i.state !== "blocked") continue;
      out[i.id] = i.blockDetail || "ready — firing shortly";
    }
    return out;
  }

  getAuto(): boolean { return this.core.auto; }

  setAuto(enabled: boolean): void { store.setAuto(this.core, enabled); }

  // ── Mutations (each one a store write) — `backlog/backlogedits.ts` ──────

  add(text: string, repoDir: string, label?: string, targetSessionId?: string, autoFire?: boolean,
    opts?: { steps?: readonly string[]; resume?: boolean; closeWhenDone?: boolean; flagWhenDone?: boolean; budget?: SessionBudget; launch?: LaunchOpts; holdForHost?: boolean; pastBudget?: BudgetWaiver; budgetPass?: BudgetPass; origin?: string; id?: string; manual?: boolean }): BacklogItem {
    return edits.add(this.core, text, repoDir, label, targetSessionId, autoFire, opts);
  }

  /** Fire it now, whatever the ladder says — a person tapped it. */
  fire(id: string): Promise<void> { return edits.fire(this.core, id); }

  markDone(id: string): void { this.core.intents.markDone(id); }
  remove(id: string): void { this.core.intents.remove(id); this.core.reviews.drop(id); }
  archive(id: string, archived: boolean): void { this.core.intents.edit(id, { archived }); }

  /** Edit a queued/failed/done item (`backlog/backlogedits.ts`). */
  update(id: string, patch: BacklogUpdatePatch): { refused?: string } { return edits.update(this.core, id, patch); }

  /** Swap two items' positions (the client's one-step reorder). */
  swap(idA: string, idB: string): void { edits.swap(this.core, idA, idB); }

  /** Apply an explicit top-to-bottom order (drag and drop). */
  reorder(ids: string[]): void { edits.reorder(this.core, ids); }

  // ── Sessions — `backlog/backlogsessions.ts` ─────────────────────────────

  /** Wire the global close-when-done default (main.ts: the synced setting). */
  setCloseWhenDoneDefault(read: () => boolean): void { sess.setCloseWhenDoneDefault(this.core, read); }

  /** Does this automatic session close itself once it is done? */
  closesWhenDone(sessionId: string): boolean { return sess.closesWhenDone(this.core, sessionId); }

  autoSlotFacts(): AutoSlotFacts { return sess.autoSlotFacts(this.core); }

  /** The session ONE fired item runs in. */
  openItemSession(i: Intent): string { return sess.openItemSession(this.core, i); }

  /** Flags first (`followUpSweep`), so a session that wants one is never closed ahead of it. */
  lingerSweep(isAttached: (id: string) => boolean): string[] { followUpSweep(this.core); return sess.lingerSweep(this.core, isAttached); }

  /** Flag for follow up the sessions whose item said so and finished ok — once per row. */
  followUpSweep(): string[] { return followUpSweep(this.core); }

  ensureRepoSession(repoDir: string): string { return sess.ensureRepoSession(this.core, repoDir); }

  resolveRepoSession(repoDir: string, adopt = false): string | null { return sess.resolveRepoSession(this.core, repoDir, adopt); }

  autoSessionCount(): number { return sess.autoSessionCount(this.core); }

  /** Type an intent's words into a session that already exists, and say what became of it. */
  deliver(i: Intent, sessionId: string): Promise<ExecutorResult> { return sess.deliver(this.core, i, sessionId); }
}
