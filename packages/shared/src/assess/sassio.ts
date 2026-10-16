/** A slice of assess.ts — moved whole from assess.ts, see docs/notes/shared-architecture.md. */
import type { Lifecycle } from "../intent.js";
import type { ItemCategory } from "../naming.js";
import { type AssessScope, type AssessSource, type AssessVerdict } from "./sassvocab.js";

// ── What goes in ─────────────────────────────────────────────────────────────

/**
 * One thing the run is asked about.
 *
 * `text` is the user's own words, in full. Nothing in this module reads its
 * length, and nothing downstream may clip it: the entire feature exists because
 * eighty-four such sentences were worth more than any forty a model would write
 * to replace them.
 */
export interface AssessItem {
  id: string;
  source: AssessSource;
  /** The words, in FULL. Never clipped, here or anywhere downstream. */
  text: string;
  /**
   * Lifecycle for an intent row; absent for a pad note.
   *
   * It is not only context for the CLI: it is **what tells a row that can be
   * RANKED from a row that has to be PUT BACK**. A `still wanted` verdict on a
   * `queued` row is a position in an order the row is already in; the same
   * verdict on a `failed` row is about a row the tick's ladder never looks at
   * again, where writing a position alone changes nothing a person could ever
   * observe. `applyAssessment` reads this field and nothing else to tell them
   * apart, so a row that arrives without it is ranked — the behaviour every
   * apply had before a failed row could be re-queued at all.
   */
  state?: Lifecycle;
  /**
   * **When the row this run judged settled** — `Intent.settledAt`, as the run
   * saw it. The other half of `state`, and only meaningful with it.
   *
   * `state: "failed"` is a state, not an event: the same row can be `failed`
   * twice over two different failures, and this document is written at the
   * START of a run that a person applies MINUTES later, from a sheet they may
   * have left open for an hour. In between, the row can have been revived by
   * Activity or by a hand tap, run, and failed again — differently. Applying
   * *still wanted* then re-runs work on the strength of a failure that is no
   * longer the row's and that nobody has read.
   *
   * So the run records WHICH failure it was looking at, and the host compares
   * it with what is on disk at apply time; a row that has settled again since
   * is refused rather than revived. `applyAssessment` does not read it — the
   * decision is unchanged, the mutation is the same one — it travels so the
   * side that performs the mutation can tell the row it judged from a row that
   * merely has the same state. The wire op carries the same fact for the same
   * reason (`intent.requeue`'s `failedAt`).
   *
   * Absent on every pad note, on every row that has not settled, and on every
   * document written before this field — which is `expectPrompt`'s posture on
   * absence: a proposal that cannot say is applied on the state alone, exactly
   * as it was before, never refused for not carrying a fact its writer had no
   * way to write.
   */
  failedAt?: number;
  /**
   * Given to the CLI so it can judge what is LEFT, but not itself verdictable.
   *
   * A finished row is how you tell that the thing next to it was already built;
   * it is not something to retire a second time. A verdict naming a context row
   * is dropped and noted, which is the difference between "read this" and
   * "decide about this".
   */
  context?: boolean;
  label?: string;
  createdAt?: number;
}

/** A pad note carrying this repo's `cwd` — the other half of "everything left". */
export interface AssessNote {
  id: string;
  text: string;
  createdAt?: number;
}

/** The document the host writes for the CLI to read. Versioned because it is a
 *  file on disk in someone's repo, and a file on disk outlives a build. */
export interface AssessInput {
  version: 1;
  /** When the host wrote it, so a file left behind says how old it is. */
  at: number;
  /** The repo it is about. */
  cwd: string;
  items: AssessItem[];
  /**
   * **The cut the run was asked about**, when it was asked about one — absent
   * is the whole repo.
   *
   * On the document rather than only on the run, because this file IS what the
   * CLI was handed and what the sheet renders a verdict against later. A
   * proposal read back a week after the fact has to be able to say "these were
   * the seven rows this judged", and the run row it came from may by then have
   * been evicted (`ASSESS_MAX_RUNS`) while the sidecar proposal lives on.
   *
   * Never a reason to alter a VERDICT: every rule that decides what a verdict
   * may say is `cleanAssessment`'s and reads `items`, which is already narrowed
   * by the time this file exists. A second rule keyed on this field would be a
   * second opinion about the same question.
   */
  scopedIds?: string[];
  /** **What the scoped ids ARE**, when they are a slot — rows that fire
   *  together (`AssessScope`). Absent on every other run. */
  scope?: AssessScope;
}

// ── What comes out ───────────────────────────────────────────────────────────

/** Why the pure layer overrode what the CLI said. Machine-readable, so a sheet
 *  can group them, plus `downgradeText` for the sentence. */
export type AssessDowngrade =
  /** A retiring verdict with nothing behind it. */
  | "no-evidence"
  /** A word that is not one of the six. */
  | "unknown-verdict"
  /** Two verdicts for one id: ambiguous about what happens to it. */
  | "duplicate"
  /** The assessment never mentioned this item at all. */
  | "unmentioned"
  /** `superseded` naming an id that was not in the input. */
  | "supersede-unknown"
  /** `superseded` naming itself. */
  | "supersede-self"
  /** A supersede chain that comes back round. */
  | "supersede-cycle"
  /** In two groups, or in a group AND carrying another verdict. */
  | "merge-conflict"
  /** The group it was in did not survive the merge rules. */
  | "merge-dropped"
  /** `merged` naming a group that does not exist. */
  | "merge-unknown";

/** One existing item, with what the run concluded about it. */
export interface AssessRow {
  id: string;
  verdict: AssessVerdict;
  /** The citation, the rationale, or the sentence saying what was ambiguous.
   *  Guaranteed non-empty on `done`/`obsolete`/`superseded` — that is the rule
   *  this whole module exists for. */
  evidence: string;
  /** `wanted`: where it sits in the order. */
  rank?: number;
  /** `superseded`: the id that covers it. Flattened — always one hop. */
  supersededBy?: string;
  /** `merged`: which surviving group. */
  gid?: string;
  /** Set when the pure layer overrode the CLI. `unclear` rows produced by a
   *  downgrade always carry one; a row the CLI itself called `unclear` does
   *  not. */
  downgraded?: AssessDowngrade;
  /**
   * What the run would CALL this row, and what kind of thing it is.
   *
   * They ride on every row the run judged, `unclear` and downgraded ones
   * included, and that is deliberate: a naming is a reading of the WORDS, not a
   * claim about the codebase, so the rule that strips a verdict for having no
   * citation has nothing to say about it. A run that could not tell whether the
   * thing was done can still tell that it is about a crash in the uploader.
   *
   * `cleanHeadline`/`cleanCategory` have already had their say by the time
   * either appears here: absent means nothing usable was written, never a
   * default.
   */
  headline?: string;
  category?: ItemCategory;
}

/** Several rows the run says are one job, plus the prompt it wrote to cover
 *  them. The highest-stakes row in the sheet: approving it means approving text
 *  the user did not write, in place of text they did. */
export interface AssessMerge {
  gid: string;
  /** 2..MAX_MERGE_SIZE ids, each in this group and no other. */
  ids: string[];
  /** The prompt that replaces them. Full text, never clipped. */
  prompt: string;
  rank?: number;
  /** Why these are one job — the evidence each dismissed member carries. */
  rationale: string;
  /** What to call the row this group posts, and what kind it is. A merged row
   *  is machine text already, so a nameless one is the worse outcome — see
   *  `AssessPost`. */
  headline?: string;
  category?: ItemCategory;
}

/** A genuinely missing piece. Prose, a rank, and what to call it. */
export interface AssessNew {
  prompt: string;
  rank?: number;
  /** Same as `AssessMerge`: the prompt is the run's own words, so titling it is
   *  not standing in for anybody. */
  headline?: string;
  category?: ItemCategory;
  /**
   * **The pad note whose words this IS, verbatim.** Set only by
   * `cleanAssessment` itself, never read off the CLI's `new` array.
   *
   * A `wanted` verdict on a pad note used to be the one verdict with nowhere to
   * go: the note was read, judged and left, because the pad is synced client
   * state the host does not own. The offer closes that, and the words on it are
   * the note's own because this module COPIED them — not because the CLI was
   * asked to and complied. That is the difference between a guarantee and a
   * hope, and it is why the field is synthesised here rather than parsed.
   *
   * It travels so the phone can clear the note once the receipt says the row
   * landed: without it the person ends up holding the same sentence in two
   * places with no way to tell which one is going to run.
   */
  fromNote?: string;
}

/**
 * **Two or more rows that contradict each other** — opposite changes to one
 * thing, or one depending on a row that runs LATER.
 *
 * Words, never a mutation: there is no choice that approves a conflict and
 * `applyAssessment` never reads this list. The phone offers *edit*, *drop one*
 * and *ignore* as the person's own separate verbs on the rows it names.
 */
export interface AssessConflict {
  cid: string;
  /** 2..MAX_CONFLICT_IDS assessable ids, distinct. */
  ids: string[];
  /** One sentence: what contradicts what. Never empty. */
  why: string;
}

/**
 * **One row that is two jobs** — the two texts it should become.
 *
 * Approving it posts both texts on the ORIGINAL row's clock and archives (not
 * cancels) the original (`AssessMutations.split`). Intent rows only, and the
 * two texts together still name every file the original named
 * (`transportPaths`) — a split that loses a path is refused by
 * `cleanAssessment`, because a picture somebody attached must not fall off
 * the work it was attached to.
 */
export interface AssessSplit {
  sid: string;
  /** The row being split. */
  id: string;
  /** Exactly `SPLIT_PARTS` non-empty texts, in run order. Never clipped. */
  texts: string[];
  /** Why this is two jobs. */
  rationale: string;
}

/** The whole proposal: what a person is being asked to approve. */
export interface AssessProposal {
  rows: AssessRow[];
  merges: AssessMerge[];
  news: AssessNew[];
  /** Contradictions the run found — words only. Absent on every proposal
   *  written before the slot check (2026-10-16). */
  conflicts?: AssessConflict[];
  /** Rows the run would split in two. Absent as above. */
  splits?: AssessSplit[];
  /**
   * What the pure layer refused, one sentence each.
   *
   * Shown, not swallowed: a merge group dropped silently is indistinguishable
   * from a merge group nobody proposed, and the difference is whether the run
   * was any good.
   */
  notes: string[];
}