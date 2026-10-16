/**
 * Part of `assessRows.ts`, the barrel every caller imports — why apply or run cannot be pressed, and watching a run happen.
 * Pure, and its imports carry `.ts` because `node --test` loads it straight off the source.
 * Map of the slices: docs/notes/assess-architecture.md.
 */
import type { AssessStep, AssessRun } from "@waterplane/shared";

/**
 * Why "apply" cannot be pressed, in the order a person can act on.
 *
 * `intentVerdict`'s ordering rule: the ladder is by what the user can DO about
 * it, not by what is cheapest to test. There being no proposal at all comes
 * first because nothing else is even a question then; a run still going and an
 * already-applied one are facts about this run; "nothing ticked" is the one a
 * tap fixes; and the tunnel is last because it is the only one the person
 * cannot do anything about from this screen.
 */
export function assessApplyBlocker(o: {
  run: AssessRun | null;
  picked: number;
  online: boolean;
  /** An apply this device has already asked for and not seen answered. */
  busy?: boolean;
}): string | null {
  const run = o.run;
  if (!run) return "no assessment has been run for this repo yet";
  if (run.status === "running") return "the assessment is still running — its verdicts are not final until it finishes";
  if (run.status === "failed") return `the run did not produce a proposal${run.detail ? ` — ${run.detail}` : ""}`;
  const p = run.proposal;
  if (!p || !(p.rows.length + p.merges.length + p.news.length + (p.splits?.length ?? 0) + (p.conflicts?.length ?? 0))) return "this run came back with nothing to decide";
  if (run.status === "applied") return "this proposal has already been applied — run a new assessment to judge what is left now";
  if (o.busy) return "the decisions have been sent — waiting for the desktop";
  if (!o.picked) return "nothing is ticked yet — tap retire it or keep it on the rows you agree with, or retire all on a strip";
  if (!o.online) return "no connection — applying starts work on the desktop, so it cannot be queued from here";
  return null;
}

/**
 * Why a new run cannot be started.
 *
 * One at a time per repo is the spec's rule and not a nicety: two assessments
 * proposing conflicting verdicts over one list is a merge nobody can do on a
 * phone. The budget gate is the host's and arrives as `budgetNote` — this
 * refuses on it rather than restating it, so the sentence stays the host's.
 */
export function assessRunBlocker(o: {
  run: AssessRun | null;
  online: boolean;
  busy?: boolean;
  /** The host's own sentence when the usage budget is closed. */
  budgetNote?: string | null;
}): string | null {
  if (o.run?.status === "running") return "an assessment is already running for this repo — two of them would propose different verdicts on one list";
  if (o.busy) return "the run has been asked for — waiting for the desktop";
  if (o.budgetNote) return o.budgetNote;
  if (!o.online) return "no connection — the run happens on the desktop";
  return null;
}

// ── Watching a run happen ────────────────────────────────────────────────────

/**
 * **What the sheet says about a run that is still going.**
 *
 * The screen used to say one sentence for the whole twenty minutes ("the
 * assessment is reading the repo"), which is the same sentence a run that died
 * in its first second shows — and on a phone there is no terminal to glance at
 * instead. So this words the host's `AssessProgress` reading, and only that:
 * every fact here came off the CLI's own stream and nothing is inferred from
 * the clock except how long ago something happened.
 *
 * Absent progress is a REAL state and is worded as one — an older host sends
 * none, and a run in its first seconds has done nothing yet. Neither is
 * "nothing is happening", and neither may read as a failure.
 */
export interface AssessWatch {
  /** The headline: the last thing the run was seen doing. */
  doing: string;
  /** How long it has been running, ticking. */
  elapsed: string;
  /** How many steps there have been, and how much of that is on screen —
   *  `assessStepCounts`'s `line`, the same arithmetic the settled run's
   *  disclosure is labelled from. */
  counts?: string;
  /**
   * How long since the run last did anything, said only once that is long
   * enough to be worth knowing. A long `Bash` or a slow read looks identical to
   * a wedged run otherwise, and the honest version of that is the age — never a
   * verdict about whether it is stuck.
   */
  quiet?: string;
  /** The run's own last words. */
  say?: string;
}

/** Past this long with no event, the reading says how long it has been quiet. */
export const ASSESS_QUIET_MS = 90_000;

/**
 * **How many steps there were, and how many of them you are being shown** — one
 * arithmetic, two places it is read.
 *
 * The settled run's disclosure said `212 steps` on a button that opens 24 rows,
 * with "the last 24 of 212" in a `title` — invisible on a phone, and a count on
 * a control that opens a different number is the badge-that-lies this repo
 * rebuilt `horizonBucket` to stop. The live panel had the honest reading
 * (`212 steps · last 24 shown`) built from its own copy of the same edge, so the
 * two could drift as well as disagree.
 *
 * So both come from here, from the same two numbers. They are worded APART on
 * purpose, `assessAcceptWords`'s split: `line` is a chip in a row of chips and
 * leads with the total, `button` is a control and therefore leads with what the
 * tap opens — the `n of N` shape every filtered view in this app uses. What they
 * can never do is name different numbers.
 *
 * `total` takes whichever is larger because the tail is a fact this device holds
 * and the count is one the host sent: a host that sends `steps: 0` beside twenty
 * events must not make the button say "0 steps" over a list of twenty.
 */
export interface AssessStepCounts {
  /** The live panel's chip. */
  line: string;
  /** The settled run's disclosure, which opens exactly `shown`. */
  button: string;
}

export function assessStepCounts(steps: number, shown: number): AssessStepCounts {
  const n = Math.max(steps || 0, shown || 0);
  const word = `step${n === 1 ? "" : "s"}`;
  const cut = shown > 0 && n > shown;
  return {
    line: cut ? `${n} ${word} · last ${shown} shown` : `${n} ${word}`,
    button: cut ? `last ${shown} of ${n} ${word}` : `${n} ${word}`,
  };
}

/** Elapsed, said the way a person watching says it: seconds while seconds are
 *  what is happening, then minutes, then hours. Pure — `format.ts`'s `dur`
 *  reads the clock itself and rounds a four-minute run to "4m" for sixty
 *  seconds at a time, which is exactly the freeze this screen is about. */
export function assessElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** One step as a verb — what the run was doing when it took it. The tool's own
 *  name is kept for anything this does not know, so a later CLI's new tool
 *  reads as itself rather than as nothing. */
export function assessStepVerb(step: AssessStep): string {
  const what = step.detail;
  switch (step.kind) {
    case "read": return what ? `reading ${what}` : "reading";
    case "search": return what ? `searching for ${what}` : "searching";
    case "edit": return what ? `writing ${what}` : "writing";
    case "run": return what ? `running ${what}` : "running a command";
    case "task": return what ? `running an agent: ${what}` : "running an agent";
    case "web": return what ? `fetching ${what}` : "fetching";
    case "say": return "thinking it over";
    default: return what ? `${step.label}: ${what}` : step.label;
  }
}

export function assessWatch(run: AssessRun | null, now: number): AssessWatch | null {
  if (!run || run.status !== "running") return null;
  const elapsed = assessElapsed(now - run.startedAt);
  const p = run.progress;
  const last = p?.tail.length ? p.tail[p.tail.length - 1] : null;
  // The order is what the run has actually got to: the answer file is written
  // last, so seeing it is the difference between "still reading" and "writing
  // its answer" — and that is the only phase this can know.
  const doing = !p || !last
    ? "starting up"
    : p.wroteOut
      ? "writing its answer"
      : assessStepVerb(last);
  const shown = p ? p.tail.length : 0;
  // A host that sends no step count at all says nothing here — "0 steps" on a
  // run in its first second is a claim about a run that has not reported yet.
  const counts = p && p.steps ? assessStepCounts(p.steps, shown).line : undefined;
  const quiet = p && now - p.at >= ASSESS_QUIET_MS ? `nothing new for ${assessElapsed(now - p.at)}` : undefined;
  return { doing, elapsed, counts, quiet, say: p?.say };
}
