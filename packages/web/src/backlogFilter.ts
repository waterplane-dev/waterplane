/**
 * What a backlog row IS, as facts a filter and a badge can both read.
 *
 * A repo's backlog is one long list — fifty-two items in the case that prompted
 * this — and every row rendered the same three words ("queued", "done") over a
 * forty-character truncation of its own text. Two questions could not be
 * answered by looking at it: how old is this, and where are the failures. The
 * search box answers neither (it matches words, and "failed" is not a word in
 * the item's text).
 *
 * So: the age of a row is a BUCKET, the same one that feeds the chip's count and
 * the cut it opens — `ageBucket` and nothing else, for the reason
 * `shared/schedule.ts` states about horizons. Two copies of "past 24h" is how a
 * chip saying 7 opens a list of nine.
 *
 * Pure on purpose (no DOM, no React, nothing imported but the item type, the
 * shared rules it must not restate, and `sendIntent.ts`'s relative-time
 * spelling, which is itself pure and which a clock chip may not fork), so
 * `node --test` runs it straight over the TypeScript:
 *
 *     node --test packages/web/src/backlogFilter.test.mjs
 *
 * ── This file is the BARREL ──────────────────────────────────────────────
 *
 * The rules live in `backlogFilter/`, one file per subject, and every caller
 * keeps importing `./backlogFilter` (the test imports `./backlogFilter.ts`, and
 * must pass untouched). Each basename is unique across `packages/` (the skill
 * map routes by basename). What each file holds:
 *
 *   rowBuckets.ts     the age and kind buckets — the ONE edge each chip's count
 *                     and its cut share (`ageBucket`, `categoryBucket`)
 *   rowFilter.ts      the cut (`matchesBacklogFilter`), the bar's sentence, the
 *                     archived hide (`hiddenByArchive`), the offline refusals
 *   cutCounts.ts      the numbers on the controls and their sentences
 *                     (`backlogCounts`, `focusRunWords`, archive/assess scope)
 *   clockGroups.ts    the GROUPS of rows that share a clock, and their seats
 *   dropClock.ts      *drop the clock*, the host hold, the budget waiver
 *   runAgain.ts       *run it again*, and what a revived row says
 *   mergeWords.ts     what a row the smart pick merged says, and its undo offer
 *   scheduleWords.ts  the schedule ↔ backlog seam, in words
 *   titleWords.ts     whose title a row wears, and *name these N*
 *   rowWords.ts       a span, the typed label, the edit form's session options, the serial holder
 *   retimeMany.ts     re-time many
 *
 * There is no `sort` file: the order is the HOST's (`order ?? createdAt`), and
 * nothing on this side re-sorts a row. `tools/backlogpins.test.mjs` pins the
 * barrel's export list, so a name cannot fall out of it in a later cut.
 */
export * from "./backlogFilter/rowBuckets.ts";
export * from "./backlogFilter/rowFilter.ts";
export * from "./backlogFilter/cutCounts.ts";
export * from "./backlogFilter/clockGroups.ts";
export * from "./backlogFilter/dropClock.ts";
export * from "./backlogFilter/runAgain.ts";
export * from "./backlogFilter/mergeWords.ts";
export * from "./backlogFilter/scheduleWords.ts";
export * from "./backlogFilter/titleWords.ts";
export * from "./backlogFilter/rowWords.ts";
export * from "./backlogFilter/retimeMany.ts";
