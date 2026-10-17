/**
 * The health index for the Health view — the same absolute 0-100 score (capped by its worst entry, trend second)
 * the phone draws above the readings (`shared/healthindex.ts`), derived here from the series file the view already read.
 * The derivation is the host's own (`shared/healthindexresponse.ts`), minus everything that host does on a clock:
 * there is no weekly refresh, no push and no stored notification mark here, so `lastRefresh` is
 * always null. PURE apart from reading the one file.
 *
 * The context entry's floor is the default warn line (`DEFAULT_CONTEXT_LIMITS`), as the
 * Always-on view weighs it; the desktop app uses the repo's own line where one was set there.
 */
import { readFileSync } from "node:fs";
import {
  DEFAULT_CONTEXT_LIMITS, healthIndexResponseOf, type HealthIndexResponse,
} from "@waterplane/shared";

export { parseHealthRows } from "@waterplane/shared";

/** The extension's remedy for an older engine's series: measure again, never the desktop's `rm` command. */
export const STALE_ENGINE_WORDS =
  "this series was measured by an older engine (size has no line-weighted mean), so it has no score until it is measured again under the bundled one";

/** The index over a series' text — shared's `healthIndexResponseOf`, as the desktop app serves it, `commits` included. */
export function healthIndexOf(text: string | null, now: number, warnChars: number = DEFAULT_CONTEXT_LIMITS.maxChars): HealthIndexResponse {
  return healthIndexResponseOf(text, {
    warnChars, now, lastRefresh: null,
    noSeries: "this folder has no repo-health series yet", staleEngine: STALE_ENGINE_WORDS,
  });
}

/** `healthIndexOf` over a file; an unreadable file is a sentence, never an index. */
export function healthIndexOfFile(file: string, now: number): HealthIndexResponse {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return healthIndexOf(null, now);
    return { series: null, move: null, words: null, lastRefresh: null, reason: "the series file could not be read" };
  }
  return healthIndexOf(text, now);
}
