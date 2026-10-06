/** A slice of smartpick.ts — moved whole from smartpick.ts, see docs/notes/smartpick-architecture.md (host). */
import type { Intent } from "@waterplane/shared";
import { smartpickFingerprint } from "@waterplane/shared";
import { SmartPickPasses } from "./hsppasses.js";
import { isCandidateRow, route } from "./hsphelpers.js";
import { HOLD_TEXT } from "./hspdeps.js";
import { MERGE_HOLD_MS, SMARTPICK_MIN_INTERVAL_MS } from "./hspknobs.js";

export class SmartPick extends SmartPickPasses {

  // ── The guard ladder ──────────────────────────────────────────────────────

  /**
   * *Is something looking over this repo's waiting items first?* — the question
   * `IntentDeps.pickHold` asks at the very last moment before a row fires.
   *
   * A sentence means HOLD (the row is blocked `picking` and this pass leaves it
   * alone); `null` means go. Every rung below is in the order it is for a
   * reason, and the order is the feature's correctness:
   *
   *  1. **Un-ticked repo.** A `Set` lookup and nothing else — no git spawn, no
   *     fingerprint, no file read. "An un-ticked repo costs exactly zero" is a
   *     claim about THIS line, and `smartpickstore.test.mjs` pins it by counting
   *     the fakes that were never called.
   *  2. **Not a candidate row.** A row aimed at a named session, a pinned
   *     *queue here*, a chained row, a hand fire: a person aimed those, and the
   *     pass has no business reconsidering them.
   *  3. **Already in flight for this cwd.** Hold immediately, with NO git, NO
   *     fingerprint work and not even the candidate list — this is the rung the
   *     second row of the same repo lands on, in the same pass, and doing any of
   *     that here would be paying twice for one look.
   *
   *     **It is asked BEFORE "fewer than two candidates", and that order is a
   *     fix, not a preference.** The other way round, a sibling leaving the list
   *     while the pass was thinking — cancelled, removed, archived, hand-fired
   *     — dropped the repo to one candidate, which answered `null`, which
   *     released the held row and started it. The answer then landed against a
   *     backlog whose next item was RUNNING: reproduced, it archived the running
   *     row and posted a merged row that would have run its words a second time.
   *     A cwd with a pass in flight always answers HOLD; the plan's stated cost
   *     for that is "at most twenty seconds", which the watchdog enforces.
   *  4. **A row the pass itself wrote, minted moments ago.** A merged row is not
   *     words anybody typed, and the pass that made it may name it as the pick —
   *     so without this the undo window was one tick wide and a sleeper met "it
   *     has already run" instead of the button. See `MERGE_HOLD_MS`.
   *  5. **Fewer than two candidates.** Nothing to sort and nothing to merge, so
   *     there is nothing a pass could conclude. No record, no spend.
   *  6. **The fingerprint has not moved.** The last pass was recorded against
   *     this exact state — same items, same order, same branch, same dirty
   *     paths, same commit subjects — so whatever it concluded is still the
   *     conclusion. This is also what makes every FAILURE terminal: a timeout
   *     records the fingerprint it started on, and the next tick reads it here
   *     and fires the order the repo already had.
   *  7. **The churn floor.** Something changed and the last look was seconds
   *     ago. Recorded as `skipped` WITH the gap, because a guard that should
   *     never fire has to be visible on the rare occasion it does.
   *
   * Nothing below this line types into anything. The pass reads a list and
   * reorders it; `--tools ""` is the mechanical guarantee, and
   * `pickhold.test.mjs` pins that no executor is reached during a hold.
   */
  async hold(row: Intent): Promise<string | null> {
    // 1 — the tick.
    if (!this.deps.isOn(row.cwd)) return null;
    // 2 — is this row one of the ones a pass decides about?
    if (!isCandidateRow(row)) return null;

    const cwd = row.cwd;
    // 3 — one look per repo, answered out of the in-flight entry, and asked
    //     before anything is counted: a repo that is mid-pass holds every row
    //     of its own, whatever the list has since become. A pass that is
    //     APPLYING counts as in flight too — see `applying` for the re-entrant
    //     tick that made that necessary.
    if (this.inflight.has(cwd) || this.applying.has(cwd)) return HOLD_TEXT;
    // 4 — a machine-written row, still inside its undo window.
    const fresh = this.mergedHold(row);
    if (fresh) return fresh;

    const cands = this.candidates(cwd);
    // 5 — nothing to decide.
    if (cands.length < 2) return null;

    const facts = await this.repoFacts(cwd);
    const fp = smartpickFingerprint(cands, facts);
    const last = this.store.lastPass(cwd);
    // 6 — nothing has changed since the last look.
    if (last && last.fp === fp) return null;

    const now = this.now();
    const since = last ? now - last.summary.at : Infinity;
    // 7 — the churn floor.
    if (last && since < SMARTPICK_MIN_INTERVAL_MS) {
      this.record(cwd, fp, this.summaryOf({
        passId: `skip-${now.toString(36)}`, at: now, outcome: "skipped", looked: cands.length,
        notes: [], durationMs: 0, merged: 0, sorted: 0, sinceMs: since, ...route(),
      }));
      return null;
    }

    this.start(cwd, fp, cands, facts, now);
    return HOLD_TEXT;
  }

  /**
   * Rung 4: is this a row the pass wrote, still inside its undo window?
   *
   * The failure it answers, measured in `REVIEW1-ux.md`: the pass applies and
   * kicks the tick in the same breath, `applySmartPick` may name the merged row
   * as the PICK and put it at the front, and the very next tick fires it. The
   * notification says "undo is on the row"; by the time a phone is picked up the
   * row is `running` and the undo is refused. So for `MERGE_HOLD_MS` the merged
   * row waits and the row behind it — one somebody typed — is what fires.
   *
   * A `Map` lookup and a subtraction, and only for a row that IS a merged row,
   * so an ordinary repo pays nothing for it. It expires by the CLOCK, never by
   * a counter: a host that restarts inside the window reads the record off disk
   * and answers the same way, and one that restarts after it does not hold at
   * all.
   */
  protected mergedHold(row: Intent): string | null {
    if (MERGE_HOLD_MS <= 0) return null;
    const rec = this.store.merge(row.id);
    if (!rec || rec.state !== "applied") return null;
    if (this.now() - rec.at >= MERGE_HOLD_MS) return null;
    // `undo`, not "put them back": while the hold is on, the button on the row
    // reads *undo* — *put them back* is what it becomes once the row has run.
    // A sentence naming the other one sends somebody looking for a button that
    // is not drawn yet.
    return `merged from ${rec.ids.length} of your items a moment ago — waiting a little, so “undo” is there before it runs`;
  }
}