// A slice of the repo-health words (../repoHealthWords.ts is the facade; docs/notes/webclient-architecture.md).

/** A cap, as a person waiting reads it: minutes past a minute and a half,
 *  because "180 s" has to be divided before it says whether to put the phone
 *  down. Not `msWords`, which prints an elapsed run where the tenth of a
 *  second IS the reading. */
export function spanWords(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return `${m} minute${m === 1 ? "" : "s"}`;
}

/** A commit as it is named on screen: short sha, and the day when there is one. */
export function commitWords(sha: string | null | undefined, day: string | null | undefined): string | null {
  if (!sha) return null;
  const short = sha.slice(0, 7);
  return day ? `${short} (${day})` : short;
}

/**
 * A rank fraction as the percentile a sentence prints — the ONE conversion on
 * this side of the wire.
 *
 * `tools/repohealth/narrate.mjs` keeps its own `pct` to a single call site and
 * says in its header what two of them cost: every percentile in production
 * printed `0th` for months because a second conversion existed and the tests
 * exercised the copy production did not use. The wire therefore carries the
 * rank as a FRACTION and this is the only place the phone turns one into a
 * number a person reads. It converts; it never derives — the rank, the slope,
 * the window size and the day the window opens are all the tool's, read
 * straight off the point.
 */
export function pctOf(rank: number): number {
  return Math.round(rank * 100);
}

/** `1st`, `2nd`, `3rd`, `11th`, `89th`. */
export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const rem10 = n % 10;
  return `${n}${rem10 === 1 ? "st" : rem10 === 2 ? "nd" : rem10 === 3 ? "rd" : "th"}`;
}

/** Grouped digits, the way every figure on these charts is written. */
export function nf(n: number): string {
  return Math.round(n).toLocaleString();
}
