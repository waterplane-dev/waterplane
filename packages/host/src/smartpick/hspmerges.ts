/** A slice of smartpick.ts — moved whole from smartpick.ts, see docs/notes/smartpick-architecture.md (host). */
import type { IntentDraft } from "@waterplane/shared";
import { backlogDraft } from "../intents/adapters.js";
import { SmartPickBase } from "./hspbase.js";
import { type MergeRecord } from "./hspstore.js";
import { oneLine } from "./hsphelpers.js";

export abstract class SmartPickMerges extends SmartPickBase {

  /**
   * One merge, from a record that is already on disk — the only path that
   * writes a merged row, taken both by an apply and by `finishApplying()`.
   *
   * Every step is safe to repeat: `post` hands back the existing row for an id
   * it already holds, `edit({archived:true})` on an archived row writes the same
   * value, and a chain already pointing at the merged row is rewired to where it
   * already points.
   */
  protected performMerge(rec: MergeRecord): { ok: boolean; notes: string[] } {
    const notes: string[] = [];
    const draft: IntentDraft = {
      ...backlogDraft({
        id: rec.mergedId, cwd: rec.cwd, text: rec.text, order: rec.order,
        steps: [rec.text], resume: rec.resume, holdForHost: rec.holdForHost,
        closeWhenDone: rec.closeWhenDone, pastBudget: rec.pastBudget,
      }),
      // The CLOCK, over `backlogDraft`'s `idle`. Two rows that waited on one
      // instant become one row that waits on the same instant — the merge folds
      // the WORDS and decides nothing about the when, which is the whole of the
      // rule that let the group through in the first place. `post()` arms it
      // (`armNew`), so a merged one-off comes back armed to its own instant
      // rather than to the moment it was written; and because the trigger is on
      // the RECORD, a boot replay posts the identical row.
      ...(rec.trigger ? { trigger: rec.trigger } : {}),
      // Provenance, under the 40-char cap `cleanIntentRow` enforces. It is what
      // the row says about itself ("written by the smart pick") and what an
      // `activityRows` title fragment reads.
      origin: `smartpick:${rec.passId}`.slice(0, 40),
    };
    const posted = this.deps.intents.post(draft);
    if (!posted.ok) {
      // ── Close the record, or it is `applying` for ever ────────────────────
      //
      // The record goes to disk BEFORE the post, which is what makes an apply
      // crash-safe; the cost of that is that a REFUSED post has to close it
      // again here. Left `applying`, it stayed in `store.applying()` — boot's
      // to-do list — and was retried on every boot, to be refused every time;
      // and `reindex()` went on telling both originals they had been merged
      // into a row the store had just declined to write. Nothing was mutated
      // (the post is the first mutation), so there is nothing to undo: the
      // record is simply marked as the non-event it was.
      rec.state = "refused";
      rec.undoneAt = this.now();
      this.store.putMerge(rec);
      notes.push(`a merge could not be written down (${posted.reason || "the store refused it"}), so its items kept their own words.`);
      return { ok: false, notes };
    }
    // `IntentDraft` has no `handOrdered` — it is the host's field and a client
    // may not set it — so the flag goes on with the one verb that owns it. A
    // merged row inherits it from any member, which is what stops a merge
    // freeing a hand-placed job to be sorted again.
    if (rec.handOrdered) this.deps.intents.edit(rec.mergedId, { handOrdered: true });

    // Set the originals aside. ARCHIVED and nothing else: an archived row is
    // non-terminal, so `compact()` never takes it, and it stays in the store
    // whole — its words, its label, its order, its verdicts, its createdAt.
    for (const id of rec.ids) this.deps.intents.edit(id, { archived: true });

    // Rewire the chains. A row chained behind a member is live and waiting on a
    // predecessor that will now never settle (an archived row is non-terminal),
    // which is a row that waits for ever under the most reassuring sentence in
    // the sheet. It is re-pointed at the row that WILL finish, and the `title`
    // snapshot goes with it so the sentence names something real.
    const ids = new Set(rec.ids);
    for (const r of this.deps.intents.list()) {
      if (r.trigger.kind !== "after" || !ids.has(r.trigger.id)) continue;
      if (r.id === rec.mergedId) continue;
      const from = r.trigger.id;
      const fromTitle = r.trigger.title;
      const res = this.deps.intents.update(r.id, { trigger: { ...r.trigger, id: rec.mergedId, title: rec.title } });
      if (!res.ok) {
        notes.push(`“${oneLine(r.label || rec.title)}” is chained behind an item this merge folded and could not be re-pointed (${res.reason || "the store refused it"}).`);
        continue;
      }
      if (!rec.rewired.some((w) => w.id === r.id)) rec.rewired.push({ id: r.id, from, fromTitle });
    }

    rec.state = "applied";
    this.store.putMerge(rec);
    return { ok: true, notes };
  }

  /**
   * Finish any apply the last process died in the middle of.
   *
   * Called on boot after `intents.reconcile()`, for the reason reconciliation
   * itself runs there: the store has to be readable and settled before anything
   * asks it questions. A record in state `applying` means the merged row may or
   * may not exist and the originals may or may not be archived — and because
   * every step is idempotent, the answer to both is the same: do them all again.
   */
  finishApplying(): void {
    const pending = this.store.applying();
    if (!pending.length) return;
    for (const rec of pending) this.whileApplying(rec.cwd, () => this.performMerge(rec));
    for (const rec of pending) this.kick(rec.cwd);
    this.deps.onChange?.();
  }

  // ── Undo ──────────────────────────────────────────────────────────────────

  /**
   * Put the originals back — the merged row's *put them back*.
   *
   * **It works after the merged row has run, and that is the point.** The old
   * shape allowed it only while the row was `queued`/`blocked` and refused it in
   * words afterwards ("bring one back by hand"), which is the sentence a person
   * who was ASLEEP almost always met: the pass applies and picks in the same
   * breath, so the window was one tick wide. The merged-row hold above widened
   * it; this makes the button work on the other side of it. The two together are
   * the safety case the "apply it automatically" choice was made on.
   *
   * Two shapes, one verb:
   *
   *  • **It has not run.** Exactly the old inverse — the machine-written row is
   *    REMOVED (its words are in the record, so nothing anybody typed is lost),
   *    the members come back to the `order` and the `archived` they each had,
   *    the chain edges go back.
   *  • **It has run, or is running.** The merged row is ARCHIVED, never removed:
   *    a row that ran is the only account of the session that ran it, and taking
   *    it away would leave that work with nothing in the list describing it. The
   *    members come back the same way and **will run again** — the answer says
   *    so, because the one thing a person must not have to guess is whether the
   *    words are going to be typed twice. A still-running merged item is NOT
   *    stopped, and the answer says that too.
   *
   * ── The order of the three steps, which is a fix ─────────────────────────
   *
   * Chains FIRST, then the members, then the merged row LAST. The other way
   * round was reproduced failing: `intents.update()` kicks the tick, `pass()`
   * runs synchronously as far as its first `await` and a chained row never
   * reaches one, so the first re-point settled every OTHER rewired row on the
   * spot — the merged row was already gone from `rows`, `readArchiveTail` skips
   * non-terminal rows, so it was not in `knownIntents` either, and `intentVerdict`
   * failed them with *"the item this waited for is gone"*. Re-pointed while the
   * merged row is still there, each chain lands on a predecessor that exists
   * (an archived member is live and known, so the chain WAITS), and the row is
   * taken away only once nothing points at it.
   *
   * Finally the id-set is remembered as REFUSED, so the next pass cannot propose
   * the same merge again. Without that the person and the machine take turns for
   * ever: undo it, the next pass proposes it, undo it again. The refusal is
   * keyed on the member texts as well as the ids, so editing one of them makes
   * it a genuinely new proposal and it is offered afresh.
   */
  undo(mergedId: string): { ok: boolean; reason?: string; detail?: string; ran?: boolean } {
    const rec = this.store.merge(mergedId);
    if (!rec) return { ok: false, reason: "that row was not made by the smart pick, so there is nothing to put back" };
    // A merge already put back and one that never happened are both "nothing
    // left to do" — said in their own words, because they are opposite facts and
    // a second tap is not a second restoration either way.
    if (rec.state === "undone") return { ok: true, detail: "already put back" };
    if (rec.state === "refused") return { ok: true, detail: "that merge was never written down, so the items still have their own words" };

    const row = this.deps.intents.get(mergedId);
    // `queued` and `blocked` are the two states in which nothing has been typed
    // anywhere. Every other one means a session has its words.
    const ran = !!row && row.state !== "queued" && row.state !== "blocked";
    const live = !!row && (row.state === "starting" || row.state === "running");
    const notes: string[] = [];

    // Every mutation below is behind `applying`, because the LAST of them is
    // the one that records the refusal: a tick re-entered by the edits above
    // would otherwise buy a pass over a backlog whose originals are back and
    // whose "no" has not been written down yet, and be handed the very merge
    // this call is undoing.
    this.whileApplying(rec.cwd, () => {
      // 1 — the chains, while the row they point at still exists.
      for (const w of rec.rewired) {
        const r = this.deps.intents.get(w.id);
        if (!r || r.trigger.kind !== "after") continue;
        const res = this.deps.intents.update(w.id, { trigger: { ...r.trigger, id: w.from, title: w.fromTitle } });
        // A chain that has itself settled cannot be re-pointed, and that is a
        // real outcome of undoing a merge that already ran: the merged row
        // finished, so the chain behind it was released and went. Said out
        // loud on the record rather than swallowed — this is the one edit a
        // *put them back* cannot take back.
        if (!res.ok) notes.push(`“${oneLine(r.label || w.fromTitle || w.id)}” was chained behind this and could not be put back (${res.reason || "the store refused it"}).`);
      }

      // 2 — the members, each to the state it actually had.
      const pairs: [string, string][] = [];
      for (const id of rec.ids) {
        this.deps.intents.edit(id, { archived: rec.prevArchived[id] ?? false, order: rec.prevOrders[id] });
        const back = this.deps.intents.get(id);
        if (back) pairs.push([id, back.payload.kind === "prompt" ? back.payload.steps[0] : ""]);
      }

      // 3 — the merged row last, and only now is nothing pointing at it.
      if (row && !ran) this.deps.intents.remove(mergedId);
      else if (row) this.deps.intents.edit(mergedId, { archived: true });

      rec.state = "undone";
      rec.undoneAt = this.now();
      if (notes.length) rec.undoNotes = notes;
      this.store.putMerge(rec);
      this.store.addRefused(rec.cwd, rec.ids, pairs);
    });
    // `lastPass` is deliberately left alone: the fingerprint has moved (archived
    // flags and orders changed), so the next pick runs a fresh pass — one that
    // already knows about the refusal.
    this.kick(rec.cwd);
    this.deps.onChange?.();
    const n = rec.ids.length;
    const head = !ran
      ? `put back — your ${n} items are in the list as they were`
      : live
        // "will run", never "will run AGAIN": the originals never ran. What ran
        // was the merged text, once — so "again" tells a person their work has
        // already been done when it has not.
        ? `the merged item is still running and has not been stopped — your ${n} originals are back in the list and will run as they were`
        : `the merged item already ran — your ${n} originals are back in the list and will run as they were`;
    return { ok: true, ran, detail: [head, ...notes].join(" · ") };
  }
}