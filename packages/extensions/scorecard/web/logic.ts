/**
 * The scorecard sheet's pure words and cuts. ONE function, `openChecks`, feeds the chip's number AND
 * the cut it opens, so the two cannot disagree about an edge. Types come from the wire contract.
 */
import { SLUG_RE, type CheckView, type ScoreView } from "../shared/wire.mts";

/** What a chip tap opens: this repo's open checks only. Null elsewhere = the whole reading. */
export interface ScoreCut { repo: string }

/** Failing and not accepted — what the chip counts and the cut shows. */
export const openChecks = (v: Pick<ScoreView, "checks">): CheckView[] => v.checks.filter((c) => c.failing && !c.accepted);

export interface Sections { open: CheckView[]; accepted: CheckView[]; passing: CheckView[] }

/** Failing / accepted / passing. A check with no verdict (score < 0) counts as passing: it loses nothing. */
export function sections(v: Pick<ScoreView, "checks">): Sections {
  return {
    open: openChecks(v),
    accepted: v.checks.filter((c) => c.failing && c.accepted),
    passing: v.checks.filter((c) => !c.failing),
  };
}

/** The checks to draw: the cut's open ones, or null = draw the sections. */
export const cutChecks = (v: Pick<ScoreView, "checks">, cut: ScoreCut | null): CheckView[] | null => (cut ? openChecks(v) : null);

export interface ScoreChip { n: number; label: string; title: string }

/** The chip (a word and the open count; the score stays in the title): only a scored view with something open. Absent, unscored and nothing open all say nothing. */
export function scoreChip(v: ScoreView | null | undefined): ScoreChip | null {
  if (!v || v.score == null) return null;
  const n = openChecks(v).length;
  if (n <= 0) return null;
  return { n, label: "failing", title: `OpenSSF Scorecard ${v.score}/10 — ${n} failing check${n === 1 ? "" : "s"}` };
}

/** "scored as" validation: null = fine, else the sentence that says why not (shown, never a greyed button). */
/** The slug rule, worded ONCE: both refusals and the field's hint quote it. */
export const SLUG_RULE = "owner/name: letters, digits, - . _ and one slash";

export function slugProblem(text: string): string | null {
  const t = text.trim();
  if (t === "") return `Type the public GitHub repo (${SLUG_RULE}).`;
  return SLUG_RE.test(t) ? null : `That is not an owner/name on GitHub (${SLUG_RULE}).`;
}

export const reasonProblem = (text: string, max: number): string | null => {
  const t = text.trim();
  if (t === "") return "Say why this is accepted — a reason is required.";
  return t.length > max ? `Keep it to ${max} characters (now ${t.length}).` : null;
};

/** The receipt for Ask Claude, worded off the host's `existing`/`state`. A finished row should not come back as existing (the host re-keys it); if one does, say its state plainly. */
export function remedyWords(check: string, r: { existing: boolean; state?: string }): string {
  if (!r.existing) return `${check} is in the backlog, waiting for your tap`;
  const st = r.state;
  if (!st || st === "queued" || st === "blocked" || st === "waiting") return `${check} is already in the backlog, waiting for your tap`;
  return `${check} is already in the backlog (${st})`;
}

/** Draft keys: one per repo + check (the accept reason) and one per repo (scored as). */
export const reasonKey = (repo: string, check: string): string => `${repo}\u0000reason\u0000${check}`;
export const slugKey = (repo: string): string => `${repo}\u0000slug`;
