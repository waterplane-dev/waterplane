/**
 * Part of `assessRows.ts`, the barrel every caller imports — the guide, ticks counted, and the apply button's summary, label and note.
 * Pure, and its imports carry `.ts` because `node --test` loads it straight off the source.
 * Map of the slices: docs/notes/assess-architecture.md.
 */
import type { AssessItem, AssessProposal } from "@waterplane/shared";
import { ASSESS_SAMPLE } from "./arowsDisplay.ts";
import { requeueWhereWords } from "./arowsAccept.ts";

/**
 * **The paragraph at the top, because the screen was unreadable without one.**
 *
 * A person met this sheet on a phone, could not tell what `accept` would do —
 * "Run someone for implementation?" — and tapped accept on everything they
 * could see, by their own account, precisely because they could not tell. A
 * screen whose only purpose is informed approval had failed at the informed
 * half, and no amount of per-row wording fixes that: the first question is not
 * "what does this row mean", it is "what is this screen, and what happens to me
 * if I am wrong".
 *
 * So: what it is (a proposal), who wrote it (the run, about words YOU wrote),
 * what it costs to be here (nothing — this screen starts nothing), what each
 * verb does, and where the one thing that acts is. The plan line is drawn only
 * when there is a plan file, because a sentence about a document that does not
 * exist is one more thing to be unsure about.
 *
 * It is TWO parts, and the split is load-bearing: `lead` is one line the sheet
 * always draws, `lines` are the bullets behind the `how this works` disclosure.
 * Drawn as one block it was a wall — four paragraphs above the rows somebody
 * came to read, in the state everybody lands in. Whichever half moves, the
 * claim "nothing on this screen builds, runs or sends anything" stays in the
 * half that is always visible.
 *
 * Here rather than in the sheet for this file's usual reason, plus one specific
 * to it: these sentences make claims about what `Apply` does, and they sit in
 * the same module as the code that says what `Apply` does, so the two are
 * changed together or the test fails.
 */
export interface AssessGuide {
  lead: string;
  lines: string[];
}

export function assessGuide(o: { repoName: string; judged: number; planPath?: string; named?: number }): AssessGuide {
  const n = o.judged;
  /**
   * The lead is ONE line, and it is the line that is always on screen.
   *
   * It carried all four claims and ran to three bold lines on a phone, at the
   * top of a head that had already spent five rows on chrome. The two that have
   * to be read before the first tap are "this is a proposal" and "nothing here
   * acts" — the second is the whole answer to *"Run someone for
   * implementation?"* — so those stay, unconditional and short enough to read
   * without wrapping. Who wrote it, about how many of whose items, is the first
   * thing behind the disclosure: a fact worth having, not a fact worth the
   * screen it was taking.
   */
  const lead = "A proposal. Nothing here builds, runs or sends anything.";
  const lines = [
    `The run read ${o.repoName} and is saying what it thinks of ${n} ${n === 1 ? "item" : "items"} you wrote — it is a proposal, not a to-do list.`,
    "retire it / keep it on a row means you agree with that verdict. Nothing happens yet.",
    `retire all on a strip agrees with every row on it in one go — you are shown the repo and ${ASSESS_SAMPLE} of the items first.`,
    // The kept-item clause grew the one case it was silently wrong about: a
    // kept row that had FAILED does not "stay where it is" — it is not in the
    // queue at all, and approving the verdict is what puts it back. Said here
    // rather than only on the row, because this is the paragraph somebody reads
    // once to find out what the screen does to them.
    "Apply, at the bottom, is the only thing that changes anything: retired items keep their words and go dim in the backlog (one tap brings one back); kept items stay where they are and each still runs in its own session when it fires — a kept item that had failed is put back in the queue and runs again when its turn comes, with its old failure kept on the row; new items are posted to the backlog the same way. Anything you left alone is untouched.",
  ];
  // **One line, and only when this run actually named anything.** The switch it
  // describes is at the END OF THE SCROLL, immediately above the apply bar, so
  // the paragraph somebody reads once to find out what this screen does to them
  // has to say the switch exists — a decision met for the first time after
  // sixty rows is a decision taken without reading, and unlike a band in the
  // fixed footer it can be scrolled past without ever being seen. The
  // protection is in the same sentence, because it is the only reason writing
  // them is a cheap thing to say yes to.
  if (o.named) {
    lines.push(
      "The run also suggested a title and a kind for each item — the switch at the bottom decides whether they are "
      + "written on the rows. A title you typed yourself is never replaced.",
    );
  }
  if (o.planPath) {
    lines.push(`read the plan opens ${o.planPath}, the run's write-up. It is for reading, not something to run — the work is the items below.`);
  }
  return { lead, lines };
}

// ── What may be pressed ─────────────────────────────────────────────────────

/** How many decisions are ticked. One number for the button and the footer. */
export function assessPickedCount(picked: { rows: ReadonlySet<string>; merges: ReadonlySet<string>; news: ReadonlySet<number>; splits?: ReadonlySet<string> }): number {
  return picked.rows.size + picked.merges.size + picked.news.size + (picked.splits?.size ?? 0);
}

/**
 * ...and how the footer says it: `4 ticked`, never `4 accepted`.
 *
 * Same rule as every picked label on this screen and the same reason: `Apply`
 * is the only thing that acts, so a count standing beside it in the past tense
 * is a claim that four things have happened. It is also the word this whole
 * change took off the controls — a footer still counting "accepted" is the old
 * vocabulary surviving in the one line that sums the decision up.
 */
export function assessPickedLabel(n: number): string {
  return `${n} ticked`;
}

/**
 * **What Apply is about to do, counted the way the host will do it.**
 *
 * The button used to say `Apply · 16`, and sixteen what was the question this
 * whole screen failed to answer. Sixteen is also not a number anybody can check
 * against a decision: what a person remembers making is "I retired ten things,
 * kept five in order and posted one new one", and that is three numbers.
 *
 * It is `applyAssessment`'s arithmetic deliberately re-walked over the same
 * proposal and the same items rather than a count of the ticks, because the
 * ticks and the mutations are NOT the same list and every difference between
 * them is a case where a restated decision would be a lie:
 *
 *   • a merge retires all of its members whether or not each member's row was
 *     ticked — so its members are counted here, and deduped against any of them
 *     that WAS ticked, or a merge of two the user also ticked reads as four;
 *   • a `wanted` row with no rank has no position to be moved to, so approving
 *     it changes nothing and it is not counted as kept;
 *   • a pad note is counted by the host and left alone (`applyProposal`), and
 *     an item this device does not hold, or one that went in as context, is not
 *     touched at all.
 *
 * `post` is merges plus new items because both come out of the host as one
 * thing: a row posted to the backlog, in its own session when it fires.
 */
export interface AssessApplySummary {
  /** Items whose words are kept and whose row goes dim. */
  retire: number;
  /** Items that stay and take the position the run proposes. */
  keep: number;
  /**
   * **Items that had FAILED and are put back in the queue** — a fourth count,
   * DISJOINT from `keep` and never folded into it.
   *
   * They are two different events and only one of them starts work: a keep
   * moves a row inside a queue it is already in, a re-queue is the row
   * rejoining one. An apply whose whole effect was to revive nineteen dead rows
   * must not restate itself as having re-sorted them, which is what a single
   * `keep` would have said — and the button restating the decision is the last
   * thing read before the only irreversible tap here.
   *
   * A row with a rank that also failed is counted HERE and not in both: the
   * host writes it a `rank` as well, but the fact worth a number is the one
   * that changes what happens next.
   */
  requeue: number;
  /** Prompts posted to the backlog — merged ones and genuinely new ones. */
  post: number;
  /**
   * **Rows this apply would put a TITLE or a KIND on** — the naming question's
   * own number, counted the way the host will count it.
   *
   * It is deliberately not `assessNameCount(proposal)`, which is how many
   * things the RUN has something to call: that number includes merges and new
   * items, whose names ride with the prompt they are posted with whether or not
   * the switch is on (`AssessPost.headline` — a posted row has no words of
   * anybody's to sit on top of, so the question does not arise). What the
   * switch decides is the other set: EXISTING rows, whose sentences somebody
   * wrote. Those are what this counts, and it counts them whether or not their
   * verdict was ticked, because naming is one answer to one question about the
   * whole run — "I do not agree this is done" is not "do not call it that".
   *
   * Independent of the switch itself, so the number means the same thing in
   * both answers; `assessApplyLabel` takes the switch and decides whether to
   * say it. A summary that quietly went to zero would be arithmetic that
   * depends on a chip.
   */
  name: number;
}

const asSet = <T>(v: ReadonlySet<T> | readonly T[]): ReadonlySet<T> => (Array.isArray(v) ? new Set(v) : (v as ReadonlySet<T>));

export function assessApplySummary(
  proposal: AssessProposal,
  picks: {
    rows: ReadonlySet<string> | readonly string[];
    merges: ReadonlySet<string> | readonly string[];
    news: ReadonlySet<number> | readonly number[];
  },
  items: readonly AssessItem[],
): AssessApplySummary {
  const okRows = asSet(picks.rows);
  const okMerges = asSet(picks.merges);
  const okNews = asSet(picks.news);
  const src = new Map<string, AssessItem>();
  for (const it of items) if (it && typeof it.id === "string" && it.id) src.set(it.id, it);
  /** What the host will actually retire: an intent row it holds and that was
   *  not handed over as context. Every other id is a no-op there. */
  const retirable = (id: string): boolean => {
    const it = src.get(id);
    return !!it && !it.context && it.source === "intent";
  };

  const retired = new Set<string>();
  let post = 0;
  for (const g of proposal.merges) {
    if (!okMerges.has(g.gid)) continue;
    post++;
    for (const id of g.ids) if (retirable(id)) retired.add(id);
  }

  let keep = 0;
  let requeue = 0;
  for (const r of proposal.rows) {
    if (!okRows.has(r.id)) continue;
    if (r.verdict === "wanted") {
      // `retirable` is the same predicate either way — it answers "is this a
      // backlog row of this repo that the host will touch at all", which is the
      // gate on every mutation and not only on a retirement.
      if (!retirable(r.id)) continue;
      // The host reads `state` and nothing else to tell a rank from a re-queue
      // (`applyAssessment`), so this reads the same field: a failed row goes
      // back in the queue whether or not it also carries a rank, and a row
      // without a rank that has NOT failed has no position to be moved to and
      // is therefore no change at all.
      if (src.get(r.id)?.state === "failed") requeue++;
      else if (r.rank != null) keep++;
      continue;
    }
    // `merged` and `unclear` rows do nothing on their own account — the merge
    // card is the decision, and an undecided row has no verdict to apply.
    if (r.verdict === "merged" || r.verdict === "unclear") continue;
    if (retirable(r.id)) retired.add(r.id);
  }

  proposal.news.forEach((_n, i) => { if (okNews.has(i)) post++; });

  // The naming half. `retirable` is the same gate as everywhere else in this
  // function — an intent row this device holds that was not handed over as
  // context — because the host will not write a name onto a pad note (the pad
  // is somebody's typing and this app never edits it) or onto a row it was only
  // given to read.
  let name = 0;
  for (const r of proposal.rows) {
    if (!r.headline && !r.category) continue;
    if (retirable(r.id)) name++;
  }

  return { retire: retired.size, keep, requeue, post, name };
}

/**
 * **The two answers the questions took**, as the button has to restate them.
 *
 * Not booleans in a parameter list, because both of them mean nothing without
 * the count that says the question was asked at all: `pinRanks` is `true` on a
 * proposal that orders nothing (it is the control's default, not a decision),
 * and `writeNames` is `true` on a run that named nothing. `ranked` is the
 * sheet's `rankedN` and `AssessApplySummary.name` is the naming count, so each
 * half is drawn only where the question it answers was on the screen.
 */
export interface AssessAnswers {
  /** The naming switch, already ANDed with "this run named an existing row". */
  writeNames?: boolean;
  /** `rankedN`: how many items this apply would give a position to. Not
   *  derivable from the summary — a failed ranked row is counted in `requeue`,
   *  not `keep`, and it still takes a position. */
  ranked?: number;
  /** The pin-ranks answer. Only read when `ranked` is above zero. */
  pinRanks?: boolean;
  /** Approved splits (a slot check's) — each archives one row and posts two. */
  splits?: number;
}

/**
 * **The button restates the whole decision** — `SendSheet`'s rule, for
 * `SendSheet`'s reason: the last thing read before a tap that acts should be
 * what the tap does, not what screen it is on.
 *
 * Zero parts are dropped rather than printed as `retire 0`, which reads as a
 * claim about something that was decided. With nothing ticked at all the button
 * cannot be pressed anyway (`assessApplyBlocker`) and says only where it acts.
 *
 * **Both questions are restated here, and that is the whole reason this takes
 * an `AssessAnswers` rather than one flag.** The two questions moved out of the
 * fixed footer and into the end of the scroll, which is the right place for
 * them (see `AssessSheet`'s `asks`) and costs one thing: they can be scrolled
 * past. The footer is what cannot be, so the footer has to carry both answers —
 * and it carried only the naming one, so a person could Apply having never seen
 * that they had also decided whether the order is marked as theirs.
 * A restatement that names one of two decisions is how the other one becomes
 * invisible.
 */
export function assessApplyLabel(s: AssessApplySummary, repoName: string, answers: AssessAnswers = {}): string {
  const parts: string[] = [];
  if (s.retire) parts.push(`retire ${s.retire}`);
  if (s.keep) parts.push(`keep ${s.keep} in order`);
  // Between the two that change nothing and the one that adds work, because
  // that is what it is: it starts nothing now, and it is the reason something
  // runs later. Named in full — `put 19 back in the queue`, never `requeue 19` —
  // since the whole complaint this answers was a screen using words a person
  // could not interpret in the last sentence before the tap.
  if (s.requeue) parts.push(`put ${s.requeue} back in the queue`);
  if (s.post) parts.push(`post ${s.post} new`);
  if (answers.splits) parts.push(`split ${answers.splits} in two`);
  // **The ranking answer, whenever there is an order to have an opinion about.**
  // Unconditional on the answer and not on a default: `order free` is as much a
  // decision as `order pinned`, and a part that appears only for one of the two
  // answers reports a choice as an exception. Two words, because the question
  // itself is one scroll position above and this is a reminder of which way it
  // was left — `ASSESS_PIN_KEEP`/`ASSESS_PIN_FREE` are where it is asked in
  // full.
  if (answers.ranked) parts.push(`order ${answers.pinRanks === false ? "free" : "pinned"}`);
  // **Last, and only when the switch says yes.** It is the one part of this
  // apply that changes nothing about what runs — a title is a label on work
  // that is going to happen either way — so it goes after the three that do and
  // after the one that decides what may re-sort them, and the default is that
  // it is not there at all: `writeNames` absent is the behaviour every apply
  // had before the question existed.
  if (answers.writeNames && s.name) parts.push(`title ${s.name}`);
  return parts.length ? `Apply in ${repoName} — ${parts.join(" · ")}` : `Apply in ${repoName}`;
}

/**
 * The sentence under the apply button: the reason this tap is allowed to be one
 * tap. Nothing is deleted and nothing is built — both halves matter, and the
 * second is the one the user who tapped through this screen was missing.
 *
 * **It takes the re-queue count now, because with one the second half stops
 * being the whole truth.** "Nothing is built or sent by this" is exactly right
 * for an apply that retires and re-sorts, and it is a claim a person would be
 * entitled to rely on — so an apply that puts nineteen failed rows back where
 * the ladder can see them has to say so in the same breath, with the three
 * facts that make it safe to tap: not now, one at a time per repo, and where
 * each one lands rather than nineteen agents in one worktree.
 *
 * That third fact used to read *each in a session of its own*, which is true of
 * a `fresh` row and false of one aimed at a session. `requeueWhereWords` is the
 * one clause now, shared with the accept verb and the two bulk titles that made
 * the same promise — see its note for why this side cannot simply look it up.
 *
 * A const would have left the old sentence standing on the one apply it no
 * longer describes, which is why this became a function rather than growing a
 * second string beside it.
 */
export function assessApplyNote(requeue: number): string {
  const base = "Retired items keep their words and can be brought back.";
  if (!requeue) return `${base} Nothing is built or sent by this.`;
  const one = requeue === 1;
  return `${base} Nothing is started now: the ${one ? "one put back runs" : `${requeue} put back run`} again when ${one ? "its turn comes" : "their turn comes"}, one at a time per repo, ${requeueWhereWords(one)}.`;
}
