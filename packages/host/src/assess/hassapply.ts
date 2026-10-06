/** A slice of assess.ts — moved whole from assess.ts, see docs/notes/assess-architecture.md (host). */
import { randomUUID } from "node:crypto";
import type { AssessChoices, IntentDraft } from "@waterplane/shared";
import { assessDismissReason, applyAssessment } from "@waterplane/shared";
import { backlogDraft } from "../intents/adapters.js";
import { type AssessIntents } from "./hassexec.js";
import { AssessStore } from "./hassstore.js";

// ── Applying one ─────────────────────────────────────────────────────────────

/** What one apply did, for the row and for the sentence the phone is told. */
export interface AssessApplyOutcome {
  ok: boolean;
  reason?: string;
  /** One line naming what happened, including the part that deliberately did
   *  not happen (pad notes). */
  detail: string;
  counts: { dismissed: number; ranked: number; posted: number; requeued: number; named: number };
  /**
   * **The pad notes whose backlog row actually LANDED** (`AssessNew.fromNote`),
   * and the one field here that is not a reading — it is a receipt somebody
   * deletes words on.
   *
   * The phone clears a ticked offer's note when the apply comes back `ok`. But
   * `intents.post` can REFUSE a row on its own (`PENDING_MAX`, a draft that
   * could never run) and the loop simply moves on, so an apply where every post
   * was refused still answers `ok` with `posted: 0`. Ticked three offers at a
   * host that is full and the phone tombstoned three notes with no row anywhere
   * — the only pad delete in this app taken on a REMOTE receipt instead of a
   * durable local copy, which is exactly why it is the one that loses words.
   *
   * So the ids travel, and the phone clears `ticked ∩ filed`. **Present and
   * empty is a claim** ("this host filed nothing"); **absent is the refusal to
   * claim** — an older daemon, or an apply that never got as far as posting —
   * and the phone must then clear nothing and say the notes were left on the
   * pad. Set on every path that RAN the posts, including the ones that posted
   * none; left absent by the guards above them.
   */
  filed?: string[];
}

/**
 * Perform exactly the mutations `applyAssessment` returned, and nothing else.
 *
 * ── Order is load-bearing ──────────────────────────────────────────────────
 *
 * The posts go FIRST, because a merge's dismissal reason names the id of the
 * row that replaces it and that id does not exist until the post lands. The
 * sentence is rebuilt with `assessDismissReason("merged", evidence, postedId)`
 * — the same function the pure layer called without it — rather than assembled
 * here, so the row and the sheet cannot word one fact two ways.
 *
 * The re-queues go before the RANKS, for the mirror-image reason: a `wanted`
 * row that had failed is on both lists, and a position is only a position once
 * the row is back in the order it names. See the loop.
 *
 * ── What "dismiss" means to each store ─────────────────────────────────────
 *
 * An intent that has not settled is `cancel`led with the verdict as its reason
 * — which is what puts the sentence ON the row, where the row is rendered — and
 * then `dismiss`ed, which is the "a person has seen this" gate a terminal row
 * must pass. Both are reversible in one tap (`requeue`), and neither deletes
 * anything. An intent that has ALREADY settled (a `failed` row is assessable)
 * cannot be cancelled and does not need to be: it is retired, with its own
 * reason, so it is only dismissed.
 *
 * A pad note is STILL NEVER EDITED HERE, and that is a decision rather than a
 * gap. The pad is a synced setting the daemon stores blind — one opaque string
 * with one `ts` — and the per-note merge that makes it safe to write is the
 * CLIENT's (`shared/pad.ts`, run on adopt). All this host could do is replace
 * the whole string, which is last-write-wins with no diff, on the store whose
 * entire job is to be the last copy of words with no target yet. So a retiring
 * verdict on a note is informational: the sheet shows it, and the count says
 * how many were judged and left on the pad rather than pretending they were
 * retired.
 *
 * What HAS changed is the other verdict. A note the run says is still worth
 * doing is now OFFERED as an ordinary post carrying the note's own words —
 * `cleanAssessment` copies them, so the row that lands is the person's
 * sentence and not a restatement of it — ticked and applied like every other
 * row on the sheet. This side posts the intent and nothing else: the note's
 * clearing is the PHONE's, on the receipt for that post, because the phone is
 * the only half that owns the document the note lives in.
 *
 * **And the receipt NAMES the notes, one by one** (`AssessApplyOutcome.filed`,
 * out on the `op.ack`). `intents.post` refuses on its own — `PENDING_MAX`, a
 * draft that could never run — and this loop moves on, so `ok` is true of an
 * apply where not one row landed. A phone clearing every ticked offer on that
 * `ok` deletes the words and leaves nothing behind them. The ids are the whole
 * fix, and `filed` being ABSENT is its own answer: clear nothing.
 */
export function applyProposal(
  intents: AssessIntents,
  store: AssessStore,
  runId: string,
  choices: AssessChoices,
  now: number = Date.now(),
): AssessApplyOutcome {
  const none = { dismissed: 0, ranked: 0, posted: 0, requeued: 0, named: 0 };
  const run = store.get(runId);
  if (!run) return { ok: false, reason: "that assessment is gone", detail: "that assessment is gone", counts: none };
  if (!run.proposal || !run.input) {
    return { ok: false, reason: "that run produced no proposal", detail: "that run produced no proposal — nothing was applied", counts: none };
  }
  // The second guard past the ack ledger's 45 minutes, and the one that catches
  // a REPLAY WITH A FRESH ackId: applying twice would post the merge twice.
  if (run.status === "applied") {
    // `requeued` is optional on the persisted row — it postdates it — so a run
    // applied by an older build answers 0 rather than `undefined`, which is the
    // truth about that apply and not a repair of it.
    const before = run.applied ? { ...run.applied, requeued: run.applied.requeued ?? 0, named: run.applied.named ?? 0 } : none;
    return { ok: false, reason: "already applied", detail: "this proposal has already been applied — run a new assessment to judge what is left now", counts: before };
  }

  const m = applyAssessment(run.proposal, choices, { runId, items: run.input.items });

  // ── Posts first: a merge's dismissal names the id that replaces it ──
  const postedFor = new Map<string, string>();
  let posted = 0;
  /**
   * …of which THESE are the pad notes the person asked to have filed — by id,
   * and only once their row is on disk.
   *
   * A post either way (`posted` counts them too), but this list is not a
   * statistic: it goes out on the `op.ack` and the phone deletes the note it
   * names. So an id joins it strictly after `intents.post` said yes. The count
   * for the sentence is `filed.length` — one fact, not two.
   */
  const filed: string[] = [];
  for (const p of m.post) {
    const id = "ai_" + randomUUID().slice(0, 8);
    /**
     * **`label` is what a PERSON typed, and this used to put machine
     * bookkeeping in it.**
     *
     * The old value was `merge of 3: a1 b2 c3` — a count and three internal
     * ids, written into the one field on the row that means "the name somebody
     * gave this". It was there to keep a merged row one tap from the sentences
     * it replaced, and that link is not lost by removing it: the ids are on
     * `AssessRun.proposal.merges[].ids`, and every retired member already wears
     * `merged into <id>` in its own result. So the row now carries a real
     * title (below) where it used to carry a receipt.
     *
     * Rows already carrying the old label KEEP it. There is no migration and
     * there should not be: rewriting `label` on rows in somebody's store to
     * tidy up a string is exactly the "words nobody typed" write this app
     * refuses, and the old text is at worst ugly.
     */
    /**
     * **…and a row carrying the person's OWN words wears no label at all.**
     *
     * `from an assessment` is true of a merge and of a genuinely new item: the
     * prompt on those was written by the run. It is a lie on a post made of a
     * pad note — those words are the person's, copied verbatim — and
     * `itemHeadline` lets a non-derived label BEAT the headline, so the label
     * would sit over their own sentence as a title claiming a machine wrote it.
     * Absent is the honest shape: the run's `headline` then shows, stamped
     * `assess`, exactly as it does on every other posted row.
     */
    const draft: IntentDraft = {
      ...backlogDraft({
        id, cwd: run.repoDir, text: p.prompt,
        label: p.fromNote ? undefined : "from an assessment",
        order: p.rank ?? now,
        // Carried whatever `writeNames` said — `AssessPost`'s note is the
        // argument, and it is the one asymmetry in the feature: the prompt on
        // this row was written by the same run in the same breath, so there are
        // no typed words for a title to stand on top of, and the alternative to
        // a machine's title here is no title at all.
        headline: p.headline, category: p.category, nameBy: "assess",
      }),
      origin: p.origin,
    };
    const r = intents.post(draft);
    if (!r.ok || !r.intent) continue;
    posted++;
    // Past the refusal check, so the id is on this list only when the row it
    // came from exists. `continue` above is the whole bug this guards.
    if (p.fromNote) filed.push(p.fromNote);
    // A posted row takes its place in the same ordering the ranks do, so it
    // takes the same answer. `IntentDraft` has no `handOrdered` — it is the
    // host's field, `smartpick.ts` pins a merged row the same way — so it is a
    // follow-up edit rather than a field on the draft.
    if (m.pinRanks) intents.edit(r.intent.id, { handOrdered: true });
    if (p.gid) postedFor.set(p.gid, r.intent.id);
  }

  // ── Then the retirements ──
  let dismissed = 0;
  let notes = 0;
  for (const d of m.dismiss) {
    if (d.source === "note") { notes++; continue; }
    const row = intents.get(d.id);
    if (!row) continue;
    const into = d.gid ? postedFor.get(d.gid) : undefined;
    // A merge whose post did not land must not retire the words it was going to
    // replace: that is the one ordering mistake here that loses work.
    if (d.verdict === "merged" && !into) continue;
    const reason = d.verdict === "merged" ? assessDismissReason("merged", d.evidence, into) : d.reason;
    intents.cancel(d.id, reason);
    intents.dismiss(d.id);
    dismissed++;
  }

  /**
   * **The order, and whether it is allowed to be re-decided.**
   *
   * `handOrdered` is what the smart pick reads to leave a row's position alone.
   * Until the apply could carry an answer, a ranking somebody had worked
   * through sixty-two verdicts to approve was unmarked — so the next item to
   * fire in this repo handed the list to a toolless pass that had seen only the
   * item text, and it re-sorted what a person had just signed off.
   *
   * Neither answer is right in general, so it is not a default: `pinRanks` is
   * the question `AssessSheet` asks at apply time, and this is the whole of
   * what it does. False leaves the rows exactly as this code has always left
   * them.
   */
  /**
   * **Then the rows that were still wanted and had stopped.**
   *
   * BEFORE the rank loop, and that order is the whole of why the two are not
   * exclusive: `applyAssessment` puts a `wanted` failed row on BOTH lists, so a
   * row put back here is ranked in the same pass and lands in the queue at the
   * position the assessment gave it. The other order would write a sort position
   * onto a terminal row and then move it — the same "a place in a queue it is
   * not in" this whole path exists to stop, for one statement of the list.
   *
   * **A refusal is not a failure of the apply.** `m.requeue` is read off the
   * run's START snapshot — a row may have been fired, finished or called off in
   * the twenty minutes since — and the manager re-asks the live state, so
   * "it already ran" is the correct, expected answer for some of these ids. It
   * is not counted (nothing was put back) and it does not stop the rest: an
   * apply that refused everything else because one row had run in the meantime
   * would be an apply nobody could use on a list that is being worked on.
   *
   * **And "still failed" is not the same row's failure.** `state` is a state,
   * not an event: a row can be failed at the snapshot, be put back by a hand
   * tap, run, and fail again on something else entirely — and the live-state
   * guard waves that through, because the answer to "is it failed?" is still
   * yes. So the INSTANT is compared: `AssessItem.failedAt` is the failure this
   * run was looking at (`buildAssessInput` stamps it), `settledAt` is what is on
   * disk now, and a row that has settled again since is SKIPPED exactly as a
   * refusal is — uncounted, and not a failure of the apply — so somebody reads
   * the new failure before the work is started over on the strength of an old
   * one. A snapshot with no stamp is applied on the state alone, which is all a
   * document written before the field can honestly support.
   *
   * ── One kick, at the end ──────────────────────────────────────────────────
   *
   * Every call here passes `kick: false`, and `intents.kick()` is called ONCE
   * after the ranks. See `AssessIntents.kick` for the failure it closes: the
   * first revived row was fired by the kick its own re-queue sent, while the
   * other eighteen revives and the entire rank loop had still to happen — so it
   * ran with neither the approved order written nor a candidate list the smart
   * pick would even look at.
   */
  const failureSeen = new Map<string, number>();
  for (const it of run.input.items) if (it.failedAt != null) failureSeen.set(it.id, it.failedAt);
  let requeued = 0;
  for (const id of m.requeue) {
    const saw = failureSeen.get(id);
    const live = intents.get(id);
    if (saw != null && live?.settledAt != null && live.settledAt !== saw) continue;
    if (intents.requeueFailed(id, { kind: "assess", runId }, { kick: false }).ok) requeued++;
  }

  let ranked = 0;
  for (const r of m.rank) {
    if (!intents.get(r.id)) continue;
    if (intents.edit(r.id, { order: r.rank, ...(m.pinRanks ? { handOrdered: true } : {}) }).ok) ranked++;
  }

  /**
   * **The titles, which are one answer about the whole run.**
   *
   * `m.name` is empty unless `writeNames` was explicitly true, so an apply from
   * a client that has never heard of the question writes nothing here — which
   * is the behaviour every apply had before it existed.
   *
   * A row counts as `named` when EITHER half was actually written, and the
   * manager's return value is what says so: a row whose title a person typed
   * refuses the headline and may still take the kind, and a row a person named
   * both halves of takes nothing at all. Counting the suggestions instead would
   * report "14 titled" over a list where thirteen were refused, which is a
   * reading degrading to a wrong number about the one thing this question was
   * asked to protect.
   *
   * Last of the four loops and still BEFORE the one kick, which is the only
   * ordering rule it has: nothing here changes whether a row runs or where it
   * sits, so it cannot be the thing the ladder is waiting for — and the kick
   * stays the last statement of the apply, so the pass it starts reads a store
   * where every one of these writes has already landed.
   */
  let named = 0;
  for (const n of m.name) {
    const wrote = intents.name(n.id, { headline: n.headline, category: n.category }, "assess");
    if (wrote.headline || wrote.category) named++;
  }
  // Now — with every re-queue written and every approved rank on the rows the
  // next pass is about to sort by.
  intents.kick();

  const counts = { dismissed, ranked, posted, requeued, named };
  const parts = [
    `${dismissed} retired`,
    `${ranked} ranked`,
    `${posted} posted`,
  ];
  // Only when it happened: the three above are the shape of every apply and a
  // `0 put back` on a repo with nothing failed is noise in a line a person reads
  // once. Worded as the verb rather than as a state ("2 put back in the queue",
  // not "2 requeued") because that is the sentence the sheet promised.
  if (requeued) parts.push(`${requeued} put back in the queue`);
  // `requeued`'s rule for `requeued`'s reason: the three above are the shape of
  // every apply and this one is not. A `0 titled` on an apply where the naming
  // question was answered *leave the rows as they are* would be the line
  // reporting the absence of something the person deliberately declined.
  if (named) parts.push(`${named} titled`);
  // `requeued`'s rule again. The two pad clauses are opposite halves of one
  // fact — what came OFF the pad into the backlog, and what was read and left
  // there — so the filing is said first and neither is said as a zero.
  if (filed.length) parts.push(`${filed.length} filed from the pad`);
  if (notes) parts.push(`${notes} pad note${notes === 1 ? "" : "s"} judged and left on the pad`);
  store.recordApplied(runId, counts, now);
  // `filed` even when empty: this host RAN the posts, so it can say what landed,
  // and "nothing did" is an answer the phone is allowed to act on. Only the
  // guards above — a missing run, a missing proposal, an already-applied one —
  // leave it absent, because they cannot say.
  return { ok: true, detail: parts.join(" · "), counts, filed };
}