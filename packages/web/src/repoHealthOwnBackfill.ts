/**
 * Reading a repo's OWN readings back over older commits (R-metrics-065) — the
 * phone's half: when the button is offered, and every sentence around it.
 *
 * The desktop does the work (`POST …/repohealth/own-backfill`, the engine's
 * `own-backfill`): it runs the repo's committed commands at older commits in
 * a scratch worktree. Pure, so the rules are pinned with no DOM
 * (`repoHealthOwnBackfill.test.mjs`).
 *
 * Offered while ANY own series has fewer readings than a curve needs — the
 * tile then says "a curve needs 2". Not offered once a run said nothing is
 * left: the button would only answer "nothing to read back" again, so the
 * sentence stands in its place (never a dimmed button).
 */
import type { RepoHealthOwnBackfillAnswer, RepoHealthPlotOwn } from "@waterplane/shared";

/** How many commits one tap asks for. The desktop clamps again. */
export const OWN_BACKFILL_COMMITS = 20;
/** The fewest readings a tile draws as a curve (`tileAbsentWords`' default). */
export const CURVE_MIN = 2;

export const ownBackfillLabel = (n: number = OWN_BACKFILL_COMMITS): string => `read back ${n} commits`;

export const OWN_BACKFILL_HINT =
  "Runs the repo's own commands at older commits, in a scratch copy on the desktop, so these tiles get a history now. " +
  "A reading a commit did not have stays a hole there, never 0. Offered while a tile has under two readings and an older day has not been read back yet.";

/** Every older day was read back, yet a tile is still thin: why, once, in place of the button. */
export const OWN_BACKFILL_DONE =
  "Every older day has been read back already. A tile still without a curve had no value on those days — " +
  "a reading of this desktop is never read back, and a command that needs a build or installed packages fails in the bare scratch copy.";

type OwnLike = { series?: readonly Pick<RepoHealthPlotOwn["series"][number], "points">[]; unread?: number; retryable?: number } | null | undefined;

const thin = (own: OwnLike): boolean =>
  !!own?.series?.some((s) => s.points.filter((p) => p.v !== null).length < CURVE_MIN);

/**
 * Is the button offered for this own block? Only while a tile is thin AND an
 * older day has no entry yet (`unread`, from the plot). An older engine sends
 * no `unread`: then the old rule, with `exhausted` (a run here said none left).
 */
export function ownBackfillOffered(own: OwnLike, exhausted = false): boolean {
  if (!own || exhausted || !thin(own)) return false;
  return typeof own.unread === "number" ? own.unread > 0 : true;
}

/** A tile is thin but no older day is left to read: say so instead of offering the button. */
export const ownBackfillDone = (own: OwnLike, exhausted = false): boolean =>
  thin(own) && (own?.unread === 0 || (own?.unread === undefined && exhausted)) && !(own?.retryable && own.retryable > 0);

/** Failed days a re-read could try — the ONE number the button's label and its offer both read. */
export const ownRetryCount = (own: OwnLike): number => (typeof own?.retryable === "number" ? own.retryable : 0);

/**
 * Is the re-read button offered? Every older day has an entry (`unread === 0`,
 * the first button is gone) and some stored day holds a failed reading. Not
 * after a re-read here that said nothing more can come of it (`retryDone`).
 */
export const ownRetryOffered = (own: OwnLike, retryDone = false): boolean =>
  !retryDone && own?.unread === 0 && ownRetryCount(own) > 0;

export const ownRetryLabel = (n: number): string => `re-read ${n} failed ${n === 1 ? "day" : "days"}`;

export const OWN_RETRY_HINT =
  "Re-runs the readings that failed at those commits, in the scratch copy on the desktop, with the repo's declared scratch setup " +
  "(linked packages, a prepare command) if its health file names one. A day that read a number keeps it.";

/** While the desktop is reading back: its own progress line where it said one. */
export function ownBackfillRunningWords(note: string | null | undefined, secs: number): string {
  const s = Math.max(0, Math.round(secs));
  return note ? `${note} · ${s}s` : `reading back on the desktop… ${s}s`;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The answer, as one sentence. A refusal or error is the HOST's sentence, as
 * it came. Counts the desktop did not send are left out, never shown as 0.
 */
export function ownBackfillResultWords(a: RepoHealthOwnBackfillAnswer | null | undefined): string | null {
  if (!a) return null;
  if (a.refused) return a.refused;
  if (a.error) return a.error;
  const s = a.summary;
  if (!s) return a.ok ? "Read back — the desktop did not say how much." : "The desktop could not read back.";
  if (typeof s.retried === "number") {
    if (s.retried === 0) return "No failed day was left to re-read.";
    if (s.values === 0) return `Nothing new: the same readings failed again on ${plural(s.retried, "day")} — the tile says why.`;
    const got: string[] = [];
    if (typeof s.values === "number") got.push(plural(s.values, "reading"));
    if (typeof s.absent === "number" && s.absent > 0) got.push(`${s.absent} still absent`);
    const head = `Re-read ${plural(s.retried, "day")}${got.length ? `: ${got.join(", ")}` : ""}`;
    const tail = s.stopped === "budget" ? " · stopped at the desktop's time budget" : "";
    return `${head}${tail}.`;
  }
  const parts: string[] = [];
  if (typeof s.read === "number") {
    if (s.read === 0 && s.left === 0) return null;
    parts.push(`Read back ${plural(s.read, "day")}`);
    const got: string[] = [];
    if (typeof s.values === "number") got.push(plural(s.values, "reading"));
    if (typeof s.absent === "number" && s.absent > 0) got.push(`${s.absent} absent (each tile says why)`);
    if (got.length) parts[0] += `: ${got.join(", ")}`;
  }
  if (s.stopped === "budget") parts.push("stopped at the desktop's time budget");
  if (typeof s.left === "number" && s.left > 0) parts.push(`${plural(s.left, "older day")} still without them — tap again to go further`);
  return parts.length ? `${parts.join(" · ")}.` : null;
}

/** Did the answer say there is nothing older left? (Then the button goes, the sentence stays.) */
export const ownBackfillExhausted = (a: RepoHealthOwnBackfillAnswer | null | undefined): boolean =>
  !!a?.ok && typeof a.summary?.retried !== "number" && a.summary?.left === 0;

/** A re-read answer after which asking again is pointless: no never-retried day left. (A run that read nothing new still leaves the days it did not reach on offer.) */
export const ownRetryDone = (a: RepoHealthOwnBackfillAnswer | null | undefined): boolean =>
  !!a?.ok && typeof a.summary?.retried === "number" && a.summary.left === 0;
