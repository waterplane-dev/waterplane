/**
 * Every sentence the repo-health sheet says, in one pure module.
 *
 * ── Why the words are not in the sheet ─────────────────────────────────────
 *
 * `tools/repohealth.mjs` is a series over git history that contains no
 * threshold, no grade and no opinion: a value is only ever shown against the
 * value it is read against, and its own test fails the build if the word
 * "good", "bad", "healthy" or "grade" appears anywhere in what it writes. A
 * phone screen is where that discipline is easiest to lose — a band coloured
 * amber, a chip reading "stale", a label saying "looking worse" are all one
 * render call away, and none of them would fail a test that lives in `tools/`.
 * So the phone's half of the wording is a module the phone's own test can hold
 * to the same rule, and the sheet is left with no string literals to slip one
 * into.
 *
 * ── Why staleness is counted in COMMITS ────────────────────────────────────
 *
 * The series is per commit, so wall-clock age is not a reading of it. This repo
 * has a 57-day hole in its history; an untouched repo is not stale, and a repo
 * that took forty commits this morning is behind by forty however recent the
 * last row's timestamp is. Every sentence here therefore names BOTH endpoints —
 * the last row's commit and HEAD — because a distance with only one end is a
 * number the reader cannot check, which is the same failure the tool's own
 * "every sentence names the number it is comparing against" test exists to
 * prevent. "The narrative was written N ago" and "the last commit was N ago"
 * are separate clauses for the same reason: folding either into the commit
 * distance would make one number carry two claims.
 *
 * ── What this module never does ────────────────────────────────────────────
 *
 * It never runs the remedy for a refusal and never paraphrases one. A mixed
 * series is a refusal the tool makes on purpose, and its fix deletes a file;
 * the ENGINE states that command for the root it measured and this module
 * quotes it, never composes it and never wires it to a button. With no such
 * command on the wire there is no sentence to write down. Nothing applies
 * itself.
 *
 * Pure: no DOM, no React, no value imports, so `node --test` runs it straight
 * over the TypeScript (`repoHealthWords.test.mjs`).
 */

/*
 * The two sentences for a desktop holding NO engine are deliberately not here:
 * they are `repoHealthUnavailableText` in `@waterplane/shared`, beside
 * `repoHealthAvailability`, because "no engine" and "this desktop cannot say"
 * are facts about the WIRE — an optional boolean whose absence means unknown
 * and never "no" (`local/no-raw-optional-cap`) — and one surface wording them
 * privately is how the two collapse into one.
 */

export * from "./repoHealthWords/repoHealthWordsEngine.ts";
export * from "./repoHealthWords/repoHealthWordsStale.ts";
export * from "./repoHealthWords/repoHealthWordsRun.ts";
export * from "./repoHealthWords/repoHealthWordsRank.ts";
export * from "./repoHealthWords/repoHealthWordsPlot.ts";
export * from "./repoHealthWords/repoHealthWordsRegion.ts";
export * from "./repoHealthWords/repoHealthWordsScope.ts";
