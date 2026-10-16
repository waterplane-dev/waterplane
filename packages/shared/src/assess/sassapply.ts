/** A slice of assess.ts — moved whole from assess.ts, see docs/notes/shared-architecture.md. */
import type { ItemCategory } from "../naming.js";
import { type AssessItem, type AssessProposal } from "./sassio.js";
import { type AssessSource, type AssessVerdict } from "./sassvocab.js";
import { type AssessChoices, assessDismissReason } from "./sasswords.js";
import { headlineNaming } from "./sassclean.js";

/** What applying needs to know that the proposal does not carry: which run this
 *  was, and which store each id's words live in. */
export interface AssessApplyContext {
  runId: string;
  items: readonly AssessItem[];
}

/** Retire this row, with the verdict and its evidence stored ON it. Never a
 *  delete: `deleteArchived` stays the only thing in this app that loses words. */
export interface AssessDismiss {
  id: string;
  source: AssessSource;
  verdict: AssessVerdict;
  /** The finished sentence, from `assessDismissReason`. */
  reason: string;
  evidence: string;
  /** Merge only: the group whose posted prompt replaces this row. */
  gid?: string;
}

/** Move this row to this position in the order. */
export interface AssessRank {
  id: string;
  rank: number;
}

/** Post this as ordinary work, with `origin` pointing back at the run. */
export interface AssessPost {
  prompt: string;
  rank?: number;
  origin: string;
  /** Merge only: the ids whose words this prompt claims to cover, so the new
   *  row is always one tap from the sentences it replaced. */
  sourceIds?: string[];
  gid?: string;
  /**
   * What to call the row this posts — carried REGARDLESS of
   * `AssessChoices.writeNames`, which is the one asymmetry in this file.
   *
   * `writeNames` is a question about the user's own rows: whether a machine
   * may put its words at the top of sentences a person wrote. A posted row has
   * no such sentences — the prompt on it was written by the same run, in the
   * same breath — so the question does not arise, and answering "no" to it
   * would buy nothing while leaving a machine-written row with no title at all,
   * which is the worse of the two outcomes for the reader.
   */
  headline?: string;
  category?: ItemCategory;
  /**
   * **The pad note whose words this IS, verbatim** — `AssessNew.fromNote`,
   * carried through to the side that performs the mutation.
   *
   * The host posts the row and still never reads or writes the pad; the phone
   * clears the note when the receipt for this post comes back. Which is the
   * only way the words do not end up in two places at once with nothing saying
   * which of them is going to run.
   */
  fromNote?: string;
}

/**
 * Put this title and this kind on this row.
 *
 * Not a dismiss and not a rank: it changes nothing about whether the row runs
 * or where it sits, which is why it is its own list rather than a field on the
 * other two. The host stamps the author (`assess`) — it is not on the wire
 * here because there is only one author this mutation can ever have, and a
 * field that can only hold one value is a field somebody will one day set to a
 * second one.
 *
 * Either half may be absent; both never are (a row with nothing to say is not
 * in the list at all).
 */
export interface AssessName {
  id: string;
  headline?: string;
  category?: ItemCategory;
}

/**
 * **Replace one row with two** — an approved `AssessSplit`.
 *
 * The host performs it as one unit: post `texts[0]` and `texts[1]` as ordinary
 * work carrying the ORIGINAL row's trigger (clock, grace, hold — the same slot
 * it was in) and `origin`, then ARCHIVE the original (never cancel: archived
 * keeps its words and can be brought back) with `assessSplitReason`. If either
 * post fails, the original is not archived. Not in `dismiss`, and the row loop
 * neither ranks nor re-queues the id: the row is going away.
 */
export interface AssessSplitApply {
  sid: string;
  /** The row being replaced. */
  id: string;
  texts: string[];
  origin: string;
  rationale: string;
}

/** Everything applying does. The host performs these; nothing else. */
export interface AssessMutations {
  dismiss: AssessDismiss[];
  rank: AssessRank[];
  post: AssessPost[];
  /** Approved splits (`AssessChoices.splits`). Conflicts never appear in the
   *  mutations at all — they are words. */
  split: AssessSplitApply[];
  /**
   * **Ids of settled rows the approved verdict puts back in the queue** — the
   * `still wanted` half that a rank cannot express.
   *
   * A `failed` row is terminal: the ladder never looks at it again, so writing
   * it a sort position is writing a place in a queue it is not in, and the
   * sheet meanwhile says "position 1 in the order" about exactly that. On the
   * desktop this was written on, the repo's backlog was 0 queued and 19 failed
   * — every verdict the run could usefully reach was one whose approval did
   * literally nothing.
   *
   * Ids, not rows: putting one back means keeping its words, its place and the
   * failure it had (`IntentRequeue`), and the row holding all three is the
   * host's. This says which rows a person approved, and the host is still free
   * to refuse one — and MUST refuse more than "it is no longer `failed`". The
   * state here was read when the run STARTED and the apply happens whenever the
   * person taps, so a row that has since been revived, run and failed AGAIN is
   * still `failed` and would pass a state-only guard while carrying a failure
   * the assessment never saw and nobody has read. The fact that tells the two
   * apart travels per row on `AssessItem.failedAt`: the host compares it with
   * the live `Intent.settledAt` and drops the id on a mismatch. An item that
   * cannot say (an older document) is applied on the state alone, as before.
   *
   * Never exclusive with `rank`: a re-queued row takes the position the
   * assessment gave it, in the queue it has just been put back into.
   */
  requeue: string[];
  /**
   * **Mark every position this apply writes as one a person decided** — see
   * `AssessChoices.pinRanks`, whose answer this carries.
   *
   * On the mutations rather than on each `AssessRank`, because it is one answer
   * to one question about the whole apply, and it governs the POSTED rows too:
   * a merged row and a newly added one take their place in the same ordering,
   * and an apply where the ranks hold but the posts drift is an ordering nobody
   * approved.
   */
  pinRanks: boolean;
  /**
   * **The titles and kinds to write onto existing rows** — empty unless
   * `AssessChoices.writeNames` was explicitly true.
   *
   * Intent rows only. A PAD note is not the host's to edit: the pad is a
   * synced document whose every write is somebody's typing, and a run adding
   * a title to it would be this app's one draft-clobbering write path. A
   * context row is not in here either — it was given to be read, not decided
   * about, and a title is a decision about it.
   *
   * Independent of every approval on the sheet: naming is one answer to one
   * question about the whole run, so a row whose verdict a person did NOT
   * accept still gets the title the run wrote for it. The two are different
   * facts — "I do not agree this is done" is not "I do not agree this is
   * about the uploader" — and tying them would make a sheet where the only
   * way to title a row is to accept a verdict about it.
   */
  name: AssessName[];
}

/** Where a row posted by an assessment came from. Capped like every other
 *  `Intent.origin`. */
export function assessOrigin(runId: string): string {
  return `assess:${runId}`.slice(0, 40);
}

/**
 * Proposal plus approvals in, the mutations to perform out.
 *
 * Three rules are load-bearing and none of them is obvious:
 *
 *   • **A merge is one decision.** Approving the group dismisses every member,
 *     whether or not each member's row was ticked separately — the thing being
 *     approved is "these N become that one", and half of it is not a smaller
 *     version of it. The converse holds too: accepting a `merged` ROW while its
 *     group is not approved does nothing, because retiring it would leave the
 *     words with nothing standing in for them.
 *   • **`wanted` is never posted — it is ranked, or, for a row that FAILED,
 *     put back in the queue.** It is never posted for the reason it never was:
 *     a second row carrying the same words is how a prompt runs twice, and the
 *     words are already on disk. For a `queued` or `blocked` row the rank is
 *     the entire content of the verdict. For a `failed` one it is not: that row
 *     is terminal, nothing will ever pick it up again, and a position written
 *     on it is a position in a queue it is not in — so the id goes on
 *     `requeue`, which is the same row, the same words and the same id, moved
 *     back to where the ladder can see it. That is a mutation, so it happens on
 *     the person's Apply tap and nowhere else.
 *   • **`unclear` does nothing at all**, however enthusiastically it is
 *     accepted. It is the verdict that means "no decision was reached", and a
 *     tap cannot supply one.
 */
export function applyAssessment(
  proposal: AssessProposal,
  choices: AssessChoices,
  ctx: AssessApplyContext,
): AssessMutations {
  const okRows = new Set(choices.rows ?? []);
  const okMerges = new Set(choices.merges ?? []);
  const okNews = new Set(choices.news ?? []);
  const src = new Map<string, AssessItem>();
  for (const it of ctx.items) if (it && typeof it.id === "string" && it.id) src.set(it.id, it);

  const origin = assessOrigin(ctx.runId);
  const dismiss: AssessDismiss[] = [];
  const rank: AssessRank[] = [];
  const post: AssessPost[] = [];
  const requeue: string[] = [];
  const done = new Set<string>();

  // Merges first: the group is the decision, and the row loop must not retire a
  // member on its own account afterwards.
  for (const g of proposal.merges) {
    if (!okMerges.has(g.gid)) continue;
    post.push({
      prompt: g.prompt, rank: g.rank, origin, sourceIds: [...g.ids], gid: g.gid,
      ...headlineNaming(g.headline, g.category),
    });
    for (const id of g.ids) {
      const it = src.get(id);
      if (!it || done.has(id)) continue;
      done.add(id);
      dismiss.push({
        id,
        source: it.source,
        verdict: "merged",
        reason: assessDismissReason("merged", g.rationale),
        evidence: g.rationale,
        gid: g.gid,
      });
    }
  }

  // Splits next, for the same reason: an approved split replaces the row, so
  // its own verdict (a rank, a re-queue) must not also be carried out on it.
  // `cleanAssessment` already refused a split beside a retiring outcome; the
  // `done` check is the second lock for a proposal that did not come through it.
  const okSplits = new Set(choices.splits ?? []);
  const split: AssessSplitApply[] = [];
  for (const s of proposal.splits ?? []) {
    if (!okSplits.has(s.sid) || done.has(s.id)) continue;
    const it = src.get(s.id);
    if (!it || it.context || it.source !== "intent") continue;
    done.add(s.id);
    split.push({ sid: s.sid, id: s.id, texts: [...s.texts], origin, rationale: s.rationale });
  }

  for (const r of proposal.rows) {
    if (!okRows.has(r.id) || done.has(r.id)) continue;
    const it = src.get(r.id);
    if (!it || it.context) continue;
    if (r.verdict === "merged" || r.verdict === "unclear") continue;
    if (r.verdict === "wanted") {
      // A pad note has no order to be moved to and no queue to be put back
      // into — its words are inert until somebody sends them, which is the
      // pad's own one tap and not this run's to spend.
      if (it.source !== "intent") continue;
      // A row that FAILED is not in the order at all, so a position on it is
      // not the verdict being carried out; putting it back is. The two are not
      // alternatives — a re-queued row still takes the place the assessment
      // gave it, and a row that has a place but no rank still gets put back.
      if (it.state === "failed") requeue.push(r.id);
      if (r.rank != null) rank.push({ id: r.id, rank: r.rank });
      continue;
    }
    done.add(r.id);
    dismiss.push({
      id: r.id,
      source: it.source,
      verdict: r.verdict,
      reason: assessDismissReason(r.verdict, r.evidence),
      evidence: r.evidence,
    });
  }

  proposal.news.forEach((n, i) => {
    if (!okNews.has(i)) return;
    // `fromNote` travels when there is one. The decision is the same decision —
    // a ticked offer is posted like any other — and the field is what lets the
    // phone clear the note this row's words came off once the post lands.
    post.push({
      prompt: n.prompt, rank: n.rank, origin,
      ...(n.fromNote ? { fromNote: n.fromNote } : {}),
      ...headlineNaming(n.headline, n.category),
    });
  });

  // ── The names, which are one answer about the whole run ──────────────────
  // Deliberately not inside the loop above: that loop is about APPROVALS, and
  // this is not one. A title goes on every intent row the run had something to
  // call, whether or not its verdict was accepted, because "I disagree that
  // this is done" says nothing about what the thing is. What gates all of it is
  // the single `writeNames` answer — absent is no, so an older client
  // applying a proposal writes no titles at all.
  const name: AssessName[] = [];
  if (choices.writeNames === true) {
    for (const r of proposal.rows) {
      if (!r.headline && !r.category) continue;
      const it = src.get(r.id);
      // A pad note has no row to title, and a context row was given to be read.
      if (!it || it.context || it.source !== "intent") continue;
      name.push({ id: r.id, ...headlineNaming(r.headline, r.category) });
    }
  }

  return { dismiss, rank, post, split, requeue, pinRanks: choices.pinRanks === true, name };
}