/** One of the person's open pull requests, as the PR card shows it (`prview.ts` builds it). */
export type PrCheckState = "running" | "passed" | "failed" | "skipped";
export type PrReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";

export interface PrCheck {
  name: string;
  state: PrCheckState;
  /** The check's own page (an Actions job URL, or a status target). Absent = none given. */
  url?: string;
}

export interface PullRequestView {
  number: number;
  title: string;
  /** Opens in the browser through the phone's existing shell-link path. */
  url: string;
  headRefName: string;
  /** Absent = the forge did not say (no review rule, or an older gh). */
  reviewDecision?: PrReviewDecision;
  checks: PrCheck[];
  /** false = conflicts; absent = not computed yet. */
  mergeable?: boolean;
  /** Auto-merge is switched on for this PR. */
  autoMerge: boolean;
  /** One sentence: why Merge cannot go through right now. Absent = nothing blocks it. */
  blockedBy?: string;
}

/** What `GET git/prs/*` answers. `prs` absent = never read / gh unavailable (NOT "no PRs"). */
export interface PrListDoc {
  prs?: PullRequestView[];
  /** Epoch ms of the reading `prs` is from. */
  at?: number;
  /** Why there is no list: a sentence, only when `prs` is absent. */
  why?: string;
}

/** The answer of every PR action (merge, auto-merge, close, failing log). */
export interface PrActionResult {
  ok: boolean;
  /** Receipt (what was done AND what was not), or the failing-check log tail. */
  output?: string;
  error?: string;
  /** Failing-log only: the page to open when there is no Actions log to tail. */
  url?: string;
}
