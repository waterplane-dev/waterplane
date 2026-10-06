/** A slice of smartpick.ts — moved whole from smartpick.ts, see docs/notes/smartpick-architecture.md (host). */
import type { BudgetWaiver, Intent, SmartPickCandidate, SmartPickFacts, SmartPickOutcome, SmartPickPlan, SmartPickSummary } from "@waterplane/shared";
import { applySmartPick, budgetWaived, cleanSmartPick, smartpickFingerprint, timedWorkKey, SMARTPICK_UNREADABLE } from "@waterplane/shared";
import { runSmartPickTask, type SmartPickRun } from "../sidecar.js";
import { promptText } from "../prompts.js";
import { SmartPickMerges } from "./hspmerges.js";
import { SMARTPICK_SYSTEM, smartpickPrompt } from "./hspprompt.js";
import { baseName, firstStep, mergedRowId, notesFor, oneLine, pickedName, route, sameWords } from "./hsphelpers.js";
import { SMARTPICK_MODEL, SMARTPICK_TIMEOUT_MS } from "./hspknobs.js";
import { type MergeRecord } from "./hspstore.js";

export abstract class SmartPickPasses extends SmartPickMerges {

  // ── Buying one pass ───────────────────────────────────────────────────────

  /**
   * Start the look, and make sure it ends.
   *
   * Fire-and-forget on purpose: `hold()` returns the sentence immediately and
   * the tick moves on to every other repo. Nothing is claimed — the row is
   * `blocked`, so `busyCwds`, `hostBusy` and `autoSlotsFree` are all untouched
   * while this one repo thinks.
   *
   * The watchdog is this side's and not only the child's. `runSmartPickTask`
   * already carries the same `timeoutMs`, but a promise that never settles for
   * any reason — a spawn wedged on a full pipe, an engine with its own idea of a
   * deadline — would hold a person's backlog item for ever, and "the pass may
   * never block a fire for ever" is the rule that outranks every other one here.
   * So the timer releases the hold whatever the call is doing, and an answer
   * that lands afterwards is recorded `late` and applied to nothing.
   */
  protected start(cwd: string, fp: string, cands: readonly SmartPickCandidate[], facts: SmartPickFacts, startedAt: number): void {
    const passId = `${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.inflight.set(cwd, { passId, fp, startedAt });

    const createdAt = new Map(this.deps.intents.list().map((r) => [r.id, r.createdAt]));
    const built = smartpickPrompt({
      repo: baseName(cwd),
      facts,
      cands,
      createdAt: (id) => createdAt.get(id) ?? startedAt,
      now: startedAt,
    });

    const { engine, model } = route();

    let settled = false;
    const release = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      if (this.inflight.get(cwd)?.passId === passId) this.inflight.delete(cwd);
      return true;
    };

    const timer = setTimeout(() => {
      if (!release()) return;
      this.record(cwd, fp, this.summaryOf({
        passId, at: this.now(), outcome: "timeout", looked: built.sent.length,
        notes: notesFor(built.omitted), durationMs: SMARTPICK_TIMEOUT_MS,
        merged: 0, sorted: 0, engine, model,
      }));
      this.kick(cwd);
    }, SMARTPICK_TIMEOUT_MS);
    // Never hold the process open for a grooming pass: `npm run restart` is
    // routine here and a 20 s timer is 20 s of a daemon that will not exit.
    timer.unref?.();

    const runner = this.deps.run ?? runSmartPickTask;
    void runner({ cwd, prompt: built.text, system: promptText("smartpick", SMARTPICK_SYSTEM), model: SMARTPICK_MODEL, timeoutMs: SMARTPICK_TIMEOUT_MS })
      .then((run) => {
        const late = settled;
        if (!release() && !late) return;
        try {
          // Held for the whole of deciding AND applying — `applying` says why.
          this.whileApplying(cwd, () =>
            this.finish({ cwd, fp, passId, run, cands: built.sent, omitted: built.omitted, facts, engine, model, late }));
        } catch (e) {
          // ── A throw AFTER the hold was released has to leave a record ─────
          //
          // Anything inside `finish` can throw — a store write, `notify` inside
          // `onApplied`, the sanitiser on adversarial output. It used to reject
          // into the `.catch` below, whose first line is `if (!release()) return`
          // — and this pass was already released, so it returned having written
          // NOTHING. No record means the fingerprint never moves, so the next
          // tick reads the backlog as changed and buys the same doomed pass
          // again, and the one after that: reproduced at four completions over
          // four ticks, capped only by the churn floor, for ever.
          //
          // ── …and a HALF-APPLIED merge has to be finished, not abandoned ──
          //
          // `apply()` → `performMerge()` is `putMerge(applying)` → `post(mg)` →
          // `edit(archived)` × n → `update(chain)` × n. A throw between the post
          // and the last archive leaves the merged row AND every one of its
          // members waiting, with the record stuck `applying` — and
          // `finishApplying()` only runs at boot. The next tick would then see a
          // fingerprint that differs from the start fp, take a fresh pass over
          // `[mg, A, B]`, and be offered a merge of the merged row with its own
          // members under a DIFFERENT `mergedRowId` — a second merged row, and an
          // undo that unwinds only one of them.
          //
          // Every step of `performMerge` is idempotent, and this is exactly what
          // boot would do. Doing it here costs nothing when there is nothing
          // half-applied (the common case: nothing in today's tree throws inside
          // `finish`), and it is the only moment at which the process still knows
          // a merge was in flight.
          for (const rec of this.store.applying()) {
            if (rec.cwd !== cwd) continue;
            try { this.whileApplying(cwd, () => this.performMerge(rec)); } catch { /* boot will retry it */ }
          }
          // Recorded against the fingerprint the pass STARTED on, like every
          // other failure, so the next tick fires the order the repo had.
          this.record(cwd, fp, this.summaryOf({
            passId, at: this.now(), outcome: "failed", looked: built.sent.length,
            detail: (e as Error)?.message || "the pass could not be applied",
            notes: notesFor(built.omitted), durationMs: this.now() - startedAt,
            merged: 0, sorted: 0, engine, model,
          }));
          this.kick(cwd);
        }
      })
      .catch((e: unknown) => {
        if (!release()) return;
        this.record(cwd, fp, this.summaryOf({
          passId, at: this.now(), outcome: "failed", looked: built.sent.length,
          detail: (e as Error)?.message || "the pass could not be run",
          notes: notesFor(built.omitted), durationMs: this.now() - startedAt,
          merged: 0, sorted: 0, engine, model,
        }));
        this.kick(cwd);
      });
  }

  /**
   * The answer came back. Decide what it is, and — only in the one good case —
   * apply it.
   *
   * Four of the five arms end in a record and nothing else, and that is the
   * safety property: `late`, `limited`, `failed` and an unreadable answer all
   * leave the backlog exactly as it was, recorded against the fingerprint the
   * pass started on, so the next tick fires the order the repo already had.
   */
  protected finish(p: {
    cwd: string; fp: string; passId: string; run: SmartPickRun;
    cands: readonly SmartPickCandidate[]; omitted: number; facts: SmartPickFacts;
    engine: SmartPickSummary["engine"]; model?: string; late: boolean;
  }): void {
    const base = {
      passId: p.passId, at: this.now(), looked: p.cands.length,
      durationMs: p.run.durationMs, engine: p.engine, model: p.model,
      tokens: p.run.usage ? { ...p.run.usage } : undefined,
      usd: p.run.usd,
      merged: 0, sorted: 0,
    };
    const done = (outcome: SmartPickOutcome, over: Partial<SmartPickSummary> = {}): void => {
      this.record(p.cwd, p.fp, this.summaryOf({ ...base, outcome, notes: notesFor(p.omitted), ...over }));
      this.kick(p.cwd);
    };

    // The watchdog already let the row go, and it may have started. Applying a
    // reorder to a backlog whose next item is running is the one way this
    // feature could reorder work that has already begun.
    if (p.late) { done("late", { detail: "the answer arrived after the item had already been let go" }); return; }
    // Somebody un-ticking the repo mid-pass ends the same way and must, but it
    // is NOT the same event, and saying "arrived too late" about it was the
    // strip telling a person something that did not happen. A pass that applied
    // itself after being switched off would be this feature's one unanswerable
    // surprise; this is that refusal, in its own words.
    if (!this.deps.isOn(p.cwd)) { done("late", { detail: "the smart pick was switched off for this repo while the pass was thinking" }); return; }
    if (p.run.limited) { done("limited", { detail: p.run.detail }); return; }
    if (p.run.failed) { done("failed", { detail: p.run.detail || SMARTPICK_UNREADABLE }); return; }

    // ── The answer was bought against a list that may no longer exist ────────
    //
    // Nothing is held while a pass thinks — that is the point of it: the row is
    // `blocked`, so the phone is free, and in those ~3 s it may `backlog.update`
    // a member's words, `intent.cancel` one, `backlog.reorder` the lot or
    // `backlog.fire` one by hand. Every one of those is allowed on a `queued`
    // row and nothing anywhere takes a lock on them.
    //
    // Applying the old answer to the new list does the two worst things this
    // module could do, both reproduced against the real store:
    //
    //  • Edit a member's text mid-pass and the merge of the OLD words is
    //    posted while the words somebody just typed are archived underneath it
    //    — CLAUDE.md's "never overwrite typed words with words nobody typed".
    //  • Cancel a member mid-pass and (with the rung order fixed above, the
    //    sibling no longer even gets out) the answer would still archive rows
    //    that are no longer waiting and post their words to run again.
    //
    // So the fingerprint is asked AGAIN here, against the same repo facts the
    // pass was built from — only the backlog half can have moved — and the
    // record goes against the CURRENT one. That is what keeps the promise the
    // whole file is arranged around: the next tick reads "nothing has changed"
    // and fires the order the person has NOW.
    const nowFp = smartpickFingerprint(this.candidates(p.cwd), p.facts);
    if (nowFp !== p.fp) {
      this.record(p.cwd, nowFp, this.summaryOf({
        ...base, outcome: "late", notes: notesFor(p.omitted),
        detail: "the list changed while the pass was thinking — nothing it said was applied",
      }));
      this.kick(p.cwd);
      return;
    }

    const proposal = cleanSmartPick(p.run.text, p.cands, this.store.refusedFor(p.cwd, p.cands));
    if (!proposal) { done("failed", { detail: SMARTPICK_UNREADABLE }); return; }

    const plan = applySmartPick(proposal, p.cands);
    const applied = this.apply(p.cwd, p.passId, plan, p.cands);
    const notes = [...plan.notes, ...applied.notes, ...notesFor(p.omitted)];
    const picked = pickedName(plan.pick, proposal, p.cands, applied.mergedIds);
    const outcome: SmartPickOutcome = applied.merged || applied.sorted ? "applied" : "noop";

    // The fingerprint of the state the apply LEFT BEHIND, not the one it found.
    // Without this every applied pass immediately looks changed again on the
    // confirming tick and the repo buys a completion per tick for ever.
    const after = smartpickFingerprint(this.candidates(p.cwd), p.facts);
    const summary = this.summaryOf({
      ...base, outcome, notes, why: proposal.why || undefined, picked,
      merged: applied.merged, mergedInto: applied.mergedIds.length || undefined, sorted: applied.sorted,
    });
    this.record(p.cwd, after, summary);
    if (applied.mergedIds.length) this.deps.onApplied?.({ cwd: p.cwd, summary, mergedRowIds: applied.mergedIds });
    this.kick(p.cwd);
  }

  // ── Performing a plan ─────────────────────────────────────────────────────

  /**
   * The mutations, in the order §2.4 of the plan settled on, and every step
   * idempotent.
   *
   * **Record first.** The `MergeRecord` goes to disk in state `applying` before
   * anything is touched, and the merged id is DETERMINISTIC — `mg` plus a hash
   * of the pass id and the sorted member ids — so a crash between any two steps
   * and a replay after it both land on `post()`'s "this id already exists"
   * branch rather than making a second row out of the same three items.
   *
   * Then: post the merged row, ARCHIVE the originals (never cancel, never
   * remove, never evict — they keep their words, their labels, their `order`,
   * their review verdicts and their `createdAt` for ever), rewire anything
   * chained behind one of them, mark the record `applied`, and only then move
   * the slots. The sort is last because it is the cheapest thing to lose: a
   * crash before it leaves a correct list in a stale order, which the next pass
   * fixes, while a crash between the post and the archive would leave the same
   * work queued twice.
   */
  protected apply(cwd: string, passId: string, plan: SmartPickPlan, cands: readonly SmartPickCandidate[]): {
    merged: number; sorted: number; mergedIds: string[]; notes: string[];
  } {
    const notes: string[] = [];
    const byId = new Map(cands.map((c) => [c.id, c]));
    const mergedIds: string[] = [];
    let merged = 0;

    for (const g of plan.merges) {
      const members = g.ids.map((id) => this.deps.intents.get(id)).filter((r): r is Intent => !!r);
      if (members.length !== g.ids.length) {
        // A row settled, was removed or was archived while the pass was
        // thinking. Folding what is left would archive work the model never
        // proposed archiving, so the group is dropped whole and said out loud.
        notes.push(`a merge was dropped: one of the items it folds is no longer waiting here.`);
        continue;
      }
      // Belt and braces behind `finish`'s fingerprint re-check. That one covers
      // the words, the order and the hand-placed flag; this covers STATE, which
      // is not in a fingerprint at all — a member that started, settled or was
      // set aside between the re-check and here. Folding one of those would
      // archive a row that is running and post its words to be typed a second
      // time, which is the failure the re-check exists to stop and is worth
      // asking twice.
      const moved = members.find((r) =>
        r.archived
        || (r.state !== "queued" && r.state !== "blocked")
        || !sameWords(r, byId.get(r.id)));
      if (moved) {
        notes.push(`a merge was dropped: “${oneLine(moved.label || firstStep(moved))}” changed while the pass was thinking.`);
        continue;
      }
      // ── A merged row is never folded AGAIN ────────────────────────────────
      //
      // `mg` comes out of a merge auto, repo-targeted and `queued`, so it is an
      // ordinary candidate like any other and a later pass can be offered
      // `[mg, C]`. The sidecar cannot represent the result: `reindex()` writes
      // `index[mg] = {mergedFrom}` and then `index[mg] = {mergedInto: mg2}`, one
      // `Map.set` overwriting the other, so the row loses one of its two chips —
      // and worse, `undo(mg)` taken before `undo(mg2)` puts A and B back in the
      // queue while `mg2` still carries their words, so the work runs twice and
      // nothing says so.
      //
      // Refused here rather than filtered out of `isCandidateRow`, because a
      // merged row is a perfectly good thing to PICK and to SORT — it is only
      // merging it a second time that has no representation. Dropped whole and
      // said out loud, exactly like the two checks above.
      const nested = members.find((r) => this.store.rowFacts(r.id)?.mergedFrom);
      if (nested) {
        notes.push(`a merge was dropped: “${oneLine(nested.label || firstStep(nested))}” is already a merged item, and “put them back” could only unwind one of the two.`);
        continue;
      }
      // ── The clock the merge is allowed on, asked of the STORE ─────────────
      //
      // `cleanSmartPick` refused a group whose members waited on different
      // clocks and `applySmartPick` recomputed the key the group may carry —
      // both against the candidate list the pass was STARTED with. A clock that
      // moved in the seconds since (*drop the clock*, a re-time, an edit to
      // *every week*) is caught one layer up: `atKey` is in the fingerprint, so
      // `finish`'s re-check answers `late` and nothing is applied at all. That
      // is the rung the test pins and the rung a person meets.
      //
      // This asks anyway, because `rec.trigger` is read from the LIVE rows two
      // lines below and this is what makes it provably the clock the merge was
      // allowed on rather than whatever the store happens to hold when the
      // write runs. Cheap — a `Set` over two rows — and the one guard that does
      // not depend on a 64-bit hash having no collisions. Dropped whole and said
      // out loud, never repaired: a merge that quietly took the newest clock
      // would be the pass deciding one.
      const keys = new Set(members.map((r) => timedWorkKey(r) ?? ""));
      const memberKey = members.length ? timedWorkKey(members[0]) ?? "" : "";
      if (keys.size > 1 || memberKey !== (g.atKey ?? "")) {
        const who = members[0] ? oneLine(members[0].label || firstStep(members[0])) : "an item";
        notes.push(`a merge was dropped: the clock on “${who}” changed while the pass was thinking — the pass never decides a clock.`);
        continue;
      }
      // The HOLD, asked exactly the same way and against the same live rows.
      // `memberKey` carries it only for a timed row, and the rows this pass
      // meets most are untimed rows that still hold (*drop the clock* keeps it,
      // by design) — so without this the two keys are an identical `""`, the
      // merge is waved through, and the row that replaces two held rows holds
      // nothing. Dropped whole and said out loud, never repaired.
      const holds = new Set(members.map((r) => !!r.holdForHost));
      const memberHold = members.length ? !!members[0].holdForHost : false;
      if (holds.size > 1 || memberHold !== !!g.holdForHost) {
        const who = members[0] ? oneLine(members[0].label || firstStep(members[0])) : "an item";
        notes.push(`a merge was dropped: the hold on “${who}” changed while the pass was thinking — the pass never drops a hold.`);
        continue;
      }
      // The WAIVER, asked the same way against the same live rows. Dropped
      // whole on a disagreement — between the members, or with the plan
      // (a waiver given or expired while the pass was thinking).
      const at = this.now();
      const waivers = new Set(members.map((r) => budgetWaived(r, at)));
      const memberWaived = members.length ? budgetWaived(members[0], at) : false;
      if (waivers.size > 1 || memberWaived !== !!g.pastBudget) {
        const who = members[0] ? oneLine(members[0].label || firstStep(members[0])) : "an item";
        notes.push(`a merge was dropped: “${who}” and the items beside it do not agree on being let past the budget — the pass never decides a budget.`);
        continue;
      }
      const timed = memberKey ? members[0] : undefined;
      const waived: BudgetWaiver | undefined = memberWaived
        ? { until: Math.min(...members.map((r) => r.pastBudget!.until)) }
        : undefined;
      const mergedId = mergedRowId(passId, g.ids);
      const rec: MergeRecord = {
        mergedId, passId, cwd, at: this.now(), state: "applying",
        ids: [...g.ids], text: g.text, why: g.why, order: g.order,
        resume: g.resume, handOrdered: g.handOrdered,
        ...(memberHold ? { holdForHost: true } : {}),
        ...(members.some((r) => r.closeWhenDone === false) ? { closeWhenDone: false }
          : members.length && members.every((r) => r.closeWhenDone === true) ? { closeWhenDone: true } : {}),
        ...(waived ? { pastBudget: waived } : {}),
        ...(timed ? { trigger: timed.trigger, atKey: memberKey } : {}),
        title: oneLine(g.text),
        prevOrders: Object.fromEntries(members.map((r) => [r.id, r.order ?? r.createdAt])),
        prevArchived: Object.fromEntries(members.map((r) => [r.id, !!r.archived])),
        rewired: [],
      };
      this.store.putMerge(rec);
      const done = this.performMerge(rec);
      notes.push(...done.notes);
      if (!done.ok) continue;
      mergedIds.push(mergedId);
      merged += g.ids.length;
    }

    // The slots last. `plan.orders` lists ONLY the rows whose value actually
    // changes — a row already in the right place is not a mutation, which is
    // what makes `sorted` an honest count of what moved.
    let sorted = 0;
    for (const o of plan.orders) {
      if (!byId.has(o.id)) continue;
      if (this.deps.intents.edit(o.id, { order: o.order }).ok) sorted++;
    }
    return { merged, sorted, mergedIds, notes };
  }
}