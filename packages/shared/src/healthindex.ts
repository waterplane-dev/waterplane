/**
 * The health score — ONE number per repo, read week by week from the
 * repo-health series (`<repo>/.waterplane/repohealth.jsonl`) against fixed
 * "good" values, capped by its worst entry, with the week-over-week trend as a
 * second line beneath it.
 *
 * **This is the one layer that judges.** The series and every sentence the
 * engine and the phone write about it stay unjudged: a reading compared to its
 * own past has no side to be on. The owner approved (2026-10-15) a separate
 * number that DOES take a side, and the side is the same for every input: each
 * metric is read as lower-is-better. That opinion lives here and nowhere else.
 *
 * Why it is ABSOLUTE now, and not chained (owner, 2026-10-17):
 *
 * - **A chained index measures a repo against itself, so a repo that was bad
 *   at its own baseline read 100.** The first version set 100 at the repo's
 *   first full week and chained ratios from there. picture-app's baseline week
 *   (2026-05-25) already had a 4,764-line file; by October the same file was
 *   8,397 lines and the headline still said 95. A number that calls the worst
 *   file in the desktop's repos "about as healthy as ever" is not a health
 *   number. So every entry is now scored against one GOOD value per metric:
 *   `100 · min(1, good / value)` — 100 at or under good, halving as the
 *   reading doubles past it.
 * - **The cap: an average of five buried an 8,397-line file.** A geometric
 *   mean lets four quiet entries outvote one on fire: before the cap
 *   picture-app averaged 66 and this repo 63 — the repo with the giant file
 *   looked the healthier of the two. So the headline is
 *   `min(mean, worst + HEALTH_SCORE_CAP_GAP)`: no repo scores more than 30
 *   above its worst entry, and `cappedBy` names that entry whenever the cap is
 *   what set the number, so the reader is told which reading holds it down.
 * - **Size reads the giant files.** The p95 the first version read is blind
 *   to the top 5% — one huge file barely moves it. Size is now two readings,
 *   blended geometrically: `lineMean` (the line-weighted mean file length,
 *   "the length of the file the average line lives in", which a giant file
 *   drags up in proportion to its weight) and `max` (the longest file).
 * - **The GOOD values are opinion, and provisional** (`HEALTH_GOOD`): numbers
 *   the owner picked from the repos on this desktop, not a standard. A repo
 *   that disagrees overrides the entry in its committed `health.json`
 *   (`central`, `tools/repohealth/central.mjs`) — the override replaces the
 *   VALUE read, never the good line — or disables it.
 *
 * The rest of the arithmetic, and why:
 *
 * - **Weeks, last row wins.** Rows bucket to ISO weeks (Monday start, UTC, off
 *   the row's own `day` string) and the LAST row of each week (greatest `ts`)
 *   is its reading — `perDay`'s semantics one level up: every family here is a
 *   STATE of the tree, and a state read earlier in the week is just an older
 *   reading. Batch rows are kept, as `perDay` keeps them.
 * - **No score over a partial basket.** A week where any ENABLED entry is
 *   absent has no score and no point — a score over four of five entries would
 *   read as a jump the week the fifth came back. Size needs BOTH `lineMean`
 *   and `max`, so rows from engines before `lineMean` existed score nothing;
 *   history comes back by re-measuring, never by guessing.
 * - **The trend is the second line.** Between consecutive SCORED weeks,
 *   `lnLink = ln(score / previous score)` feeds the move detector
 *   (`assessHealthMove`) exactly as the chained links did. A prereg or
 *   `central` change still marks the week `gap` — the link across it is not
 *   used to call a move, because the definitions moved — but the score itself
 *   is shown as measured: an absolute score has nothing to carry.
 * - **Nothing here invents a reading**: a value that is not a finite number is
 *   absent for that week; no scored week means no series (`null`), never a
 *   number nobody measured.
 * - **A repo may disable or override an entry.** Disabled: the entry leaves
 *   the mean, the cap and the alerts. Overridden: the repo's number is the
 *   value read (for size it replaces `lineMean`; the longest file stays the
 *   engine's). Either way the row carries a fingerprint of what was applied
 *   (`central.fp`), and a change of it marks the week `gap` like a prereg
 *   change — a repo's own tweak is never a health move.
 * - **Alerts name the offender.** Any entry (or size sub-reading) scoring
 *   under 50 is a `warn`, under 25 `severe`, each with ONE sentence worded
 *   here so the phone and VS Code say it alike; the longest-file alert names
 *   the file.
 */

/** The five baskets the score reads, in the order the body names them. */

export {
  HEALTH_ENTRIES,
  HEALTH_GOOD,
  HEALTH_CONTEXT_GOOD_SHARE,
  HEALTH_SCORE_CAP_GAP,
  HEALTH_ALERT_WARN,
  HEALTH_ALERT_SEVERE,
  HEALTH_INDEX_MIN_WEEKS,
  HEALTH_INDEX_MIN_MONTH_WINDOWS,
  HEALTH_INDEX_MONTH_WEEKS,
  HEALTH_INDEX_LOW_PCT,
  HEALTH_INDEX_HIGH_PCT,
  HEALTH_INDEX_MIN_POINTS,
  HEALTH_INDEX_DEFAULT_WARN_CHARS,
  HEALTH_NO_CLAUDE_MD,
} from "./healthindex/types.js";
export type {
  HealthEntry,
  HealthSeriesRow,
  HealthRowCentral,
  HealthSizeParts,
  HealthAlertSubject,
  HealthAlert,
  HealthIndexPoint,
  HealthIndexSeries,
} from "./healthindex/types.js";
export {
  healthScore,
  isoWeekOf,
  healthWeeks,
  healthContextGood,
  healthEntryReadings,
  healthEntryValues,
  centralOf,
} from "./healthindex/readings.js";
export type {
  HealthEntryReadings,
} from "./healthindex/readings.js";
export {
  HEALTH_ENTRY_LABEL,
  healthCapWords,
  healthIndex,
  healthRowScore,
} from "./healthindex/score.js";
export {
  thinCommitPoints,
  healthIndexCommits,
  healthCommitsAvailability,
} from "./healthindex/commits.js";
export type {
  HealthCommitPoint,
  HealthCommitSeries,
} from "./healthindex/commits.js";
export {
  HEALTH_INDEX_VS_WEEKS,
  healthIndexVs,
} from "./healthindex/vs.js";
export type {
  HealthIndexVs,
} from "./healthindex/vs.js";
export {
  assessHealthMove,
} from "./healthindex/move.js";
export type {
  HealthMove,
  HealthMoveOpts,
} from "./healthindex/move.js";
export {
  signedPoints,
  healthWeekWhen,
  healthMoveWords,
} from "./healthindex/words.js";
export type {
  HealthWords,
} from "./healthindex/words.js";
export {
  repoHealthIndexOf,
} from "./healthindex/repoindex.js";
export type {
  RepoHealthIndex,
  HealthIndexResponse,
} from "./healthindex/repoindex.js";
