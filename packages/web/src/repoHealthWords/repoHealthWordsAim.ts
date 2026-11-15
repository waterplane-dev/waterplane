// A slice of the repo-health words (../repoHealthWords.ts is the facade; docs/notes/webclient-architecture.md).

/**
 * **Which way is better, on every tile** — the owner's call (2026-11-14):
 * "every metric needs a clear hint of larger or smaller is better, or if it's
 * not as easy as that". This is the ONE place region 2 takes a side, and it
 * takes it per METRIC, never per reading: the line is the same whatever the
 * value or slope, so it never says whether today is good news — the reader
 * holds the slope against it. Still no hue: the line is ink, like the slope.
 *
 * `depends` is a reason in words, never a silent blank: a reading where both
 * directions can be good news says so and says why. A key the tool adds
 * later has NO line until it is added here (absent, never a guess) — and
 * `repoHealthWords.test.mjs` fails until it is.
 */
export type SeriesAim = { better: "lower" | "higher" } | { depends: string };

export const SERIES_AIM: Readonly<Record<string, SeriesAim>> = {
  "size.p95": { better: "lower" },
  "retouch.rate": { better: "lower" },
  "hatches.perKloc": { better: "lower" },
  "context.claudeMdChars": { better: "lower" },
  "context.descChars": { better: "lower" },
  "context.skillCount": { depends: "more skills can mean less text in every turn (each loads only when used), but each adds a description line that rides along always — read it with the description chars" },
  "untested.count": { better: "lower" },
  "graph.cycleFiles": { better: "lower" },
  "graph.fanOutP95": { better: "lower" },
  "habits.fixAfterChange": { better: "lower" },
  "habits.deletionRatio": { depends: "deleting is cleanup up to a point; far below 1 for weeks means only growth, far above 1 means removing more than building — a steady repo sits near but under 1" },
  "habits.netNegative": { depends: "a share of commits that remove more than they add is cleanup; none means nothing is ever trimmed, most means little is being built" },
  "habits.testsWithCode": { better: "higher" },
  "habits.commitSizeP95": { better: "lower" },
};

/** The aim for a tile: the repo's declared `better` for its own readings, the catalog for the engine's. */
export function seriesAim(key: string, declared?: "lower" | "higher" | null): SeriesAim | null {
  if (declared === "lower" || declared === "higher") return { better: declared };
  if (declared === null) return { depends: "the repo declares no direction for this reading" };
  return SERIES_AIM[key] ?? null;
}

/** The short line under the value (`short`), and the reason an open tile adds (`why`). */
export function aimWords(aim: SeriesAim | null): { short: string; why: string | null } | null {
  if (!aim) return null;
  if ("better" in aim) return { short: aim.better === "lower" ? "lower is better" : "higher is better", why: null };
  return { short: "neither way is simply better", why: aim.depends };
}
