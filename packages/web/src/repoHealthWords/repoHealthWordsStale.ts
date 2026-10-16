// A slice of the repo-health words (../repoHealthWords.ts is the facade; docs/notes/webclient-architecture.md).
import { commitWords, nf } from "./repoHealthWordsFmt.ts";

/** A duration as the sheet prints it. One decimal below a minute, because the
 *  difference between 2.1 s and 18.4 s is the whole reading of a run. */
export function msWords(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`;
}

export interface StalenessInput {
  /** First-parent commits between the last row and HEAD. `null`/absent = the
   *  host could not work it out, which is its own sentence and never a zero. */
  behind?: number | null;
  lastSha?: string | null;
  /** The day the tool itself recorded for that commit — `%ci`, the commit's own
   *  UTC offset. */
  lastDay?: string | null;
  headSha?: string | null;
}

/**
 * How far the series is behind the tree, with both ends named.
 *
 * Null only when there is no last row — that case is the empty state, which
 * says something else entirely. Never a colour and never hidden: a reading that
 * is four commits old is still a reading, and a band that disappears when it is
 * current is a band a person learns to stop looking for.
 */
export function stalenessWords(a: StalenessInput): string | null {
  const row = commitWords(a.lastSha, a.lastDay);
  if (!row) return null;
  // HEAD is named by sha ALONE. The wire carries `head.ts` and no day on
  // purpose: `tools/repohealth/git.mjs` derives every day from `%ci`, the
  // commit's own offset, because 22 of this repo's 157 commits land in the
  // 22:00 hour and `new Date(ts)` would file them under whichever day the
  // reader's phone is in. A parenthetical invented here would be the same bug
  // with a smaller blast radius. How recent HEAD is has its own clause,
  // `lastCommitWords`, where a relative age says nothing about a calendar day.
  const head = commitWords(a.headSha, null);
  if (a.behind == null) {
    return `could not tell how far behind — last row ${row}, HEAD ${head ?? "unknown"}`;
  }
  if (a.behind <= 0) {
    return head ? `up to date — HEAD ${head} is the last row` : `up to date — ${row} is the last row`;
  }
  const n = `${a.behind} commit${a.behind === 1 ? "" : "s"} since the last reading`;
  return `${n} — last row ${row}, HEAD ${head ?? "unknown"}`;
}

/**
 * The ONE line above the series' charts: how far behind, and how much history.
 *
 * Four grey paragraphs used to stand before the first number — the comparator,
 * the intro, the engine and this line with both shas, two ages and the
 * definition in it. The reader's first question is "is this current, and how
 * much is there", so that is all this says; `stalenessWords` (both endpoints),
 * the two ages and `seriesSizeWords` (the definition) fold under it, unchanged.
 * Still counted in COMMITS, and null exactly where `stalenessWords` is.
 */
export function seriesStatusWords(a: StalenessInput & { rows?: number | null; days?: number | null }): string | null {
  if (!commitWords(a.lastSha, a.lastDay)) return null;
  const distance = a.behind == null ? "could not tell how far behind"
    : a.behind <= 0 ? "up to date"
    : `${nf(a.behind)} commit${a.behind === 1 ? "" : "s"} since the last reading`;
  if (!a.rows) return distance;
  const days = a.days ? ` over ${nf(a.days)} day${a.days === 1 ? "" : "s"}` : "";
  return `${distance} · ${nf(a.rows)} commit${a.rows === 1 ? "" : "s"} measured${days}`;
}

/** How much history is in the file, and under which definition — the basis
 *  every percentile in the narrative is a position within. A rank quoted
 *  without the size of its window is the one kind of number this tool never
 *  prints, and the screen around it must not either. */
export function seriesSizeWords(series: { rows?: number; days?: number; preregVersion?: string } | null | undefined): string | null {
  if (!series || !series.rows) return null;
  const days = series.days != null ? ` over ${series.days} day${series.days === 1 ? "" : "s"}` : "";
  const def = series.preregVersion ? `, definition ${series.preregVersion}` : "";
  return `${series.rows} row${series.rows === 1 ? "" : "s"}${days}${def}`;
}

/** Whatever the run said on the way past. Absent, never an empty heading. */
export function warningsWords(warnings: readonly string[] | null | undefined): string | null {
  if (!warnings || !warnings.length) return null;
  return `${warnings.length === 1 ? "warning" : "warnings"}: ${warnings.join(" · ")}`;
}

/**
 * The request never reached the desktop.
 *
 * Distinct from every outcome above, which are things the engine DID. It read
 * "the refresh could not be asked for: Failed to fetch" — a sentence under
 * this repo's heading, which reads as this repo's fault. The failure is the
 * transport: the tunnel, the radio, a daemon that is not up. So it says where
 * it stopped and then the two things a reader wonders next — nothing ran, and
 * nothing about this repo was read.
 */
export function refreshFailedWords(error: string): string {
  return (
    `the request did not reach the desktop: ${error}. Nothing ran there, and nothing about this ` +
    "repo was read — what is on screen is what was already on it."
  );
}

/** Rows whose commit is no longer on first-parent (a rebase, an amend, a
 *  dropped branch). Its own clause, never folded into the commit distance:
 *  those rows are not behind, they are about a history this repo no longer has. */
export function staleRowsWords(staleRows: number | null | undefined): string | null {
  const n = staleRows ?? 0;
  if (n <= 0) return null;
  return (
    `${n} row${n === 1 ? "" : "s"} in the file measure${n === 1 ? "s" : ""} a commit this repo no longer ` +
    "has — a rebase, an amend or a dropped branch. They stay in the file, which is append-only, " +
    "and are left out of the reading."
  );
}

/** When the prose was last written. Separate from the commit distance: the
 *  narrative is appended only on a day something moved, so its age says nothing
 *  about how current the series is. */
export function narrativeWrittenWords(ago: string): string {
  return `narrative written ${ago}`;
}

/** When the repo last took a commit. Also separate: an untouched repo is not
 *  behind, and this is the clause that says so without implying it. */
export function lastCommitWords(ago: string): string {
  return `last commit ${ago}`;
}
