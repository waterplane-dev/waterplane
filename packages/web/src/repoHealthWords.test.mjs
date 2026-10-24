/**
 * The repo-health sheet's words, pinned without a browser and without a host.
 *
 * `repoHealthWords.ts` has no DOM and no value imports, so it runs the way
 * `setupRemedy.test.mjs` runs — `node --test` straight over the TypeScript:
 *
 *     node --test packages/web/src/repoHealthWords.test.mjs
 *
 * What is worth pinning is what breaks SILENTLY. A staleness sentence that
 * names one endpoint still reads as a sentence; it just cannot be checked. A
 * mixed-version band that drops a version still reads as a warning; it just no
 * longer contains the evidence for the refusal it predicts. A narrative split
 * that loses the last day still renders; it just shows less than the tool
 * wrote. And a verdict word anywhere in here turns a tool that deliberately
 * holds no opinion into a screen that does — which is the one failure
 * `tools/repohealth.test.mjs` already fails the build over, and which nothing
 * in `tools/` can see once the wording moves to the phone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { KPI_MEANING, rankChipWords, kpiMeaning,
  axisDayWords,
  emptySeriesWords,
  engineLineWords,
  lastCommitWords,
  mixedVersionWords,
  msWords,
  narrativeWrittenWords,
  outcomeWords,
  drawnPageWords,
  pointReadoutWords,
  readFailedWords, outcomeRepeatsReadError,
  refreshBusyLabel,
  refreshFailedWords,
  refreshLabel, approveRunLabel, skipOwnLabel,
  runningWords,
  seriesHeadWords,
  seriesSizeWords,
  seriesStatusWords,
  stackReadoutWords,
  stalenessWords,
  staleRowsWords,
  warningsWords,
} from "./repoHealthWords.ts";
import { SCRUB_HINT } from "./kit/chart/chartWords.ts";
import { SCRUB_HINT as REGION_SCRUB_HINT, axisModeWords, commitsAbsentWords, thinnedWords } from "./healthIndexWords.ts";
import { middleEllipsis } from "./repoHealthWords/repoHealthWordsFmt.ts";
import { joinNarrativeDays, splitNarrativeDays } from "./narrativeDays.ts";
import * as tileWords from "./repoHealthTileWords.ts";

const NARRATIVE = fileURLToPath(new URL("../../../.claude/outbox/repohealth.md", import.meta.url));

// ───────────────────────────────────────────────────────────────────────────
// Staleness: counted in commits, and never with one end missing.
// ───────────────────────────────────────────────────────────────────────────

test("behind names both endpoints", () => {
  const s = stalenessWords({ behind: 2, lastSha: "a1b2c3d9f", lastDay: "2026-09-19", headSha: "e4f5a6b0c" });
  assert.equal(s, "2 commits since the last reading — last row a1b2c3d (2026-09-19), HEAD e4f5a6b");
  assert.ok(s.includes("a1b2c3d"), "the last row's commit is named");
  assert.ok(s.includes("e4f5a6b"), "and so is the one it is being read against");
});

test("one commit behind is singular", () => {
  assert.match(stalenessWords({ behind: 1, lastSha: "aaaaaaa", headSha: "bbbbbbb" }), /^1 commit since/);
});

test("up to date still names the commit it is up to date WITH", () => {
  const s = stalenessWords({ behind: 0, lastSha: "a1b2c3d", lastDay: "2026-09-21", headSha: "a1b2c3d" });
  assert.equal(s, "up to date — HEAD a1b2c3d is the last row");
});

test("behind null is its own sentence and never a zero", () => {
  const s = stalenessWords({ behind: null, lastSha: "a1b2c3d", lastDay: "2026-09-19", headSha: null });
  assert.equal(s, "could not tell how far behind — last row a1b2c3d (2026-09-19), HEAD unknown");
  assert.doesNotMatch(s, /up to date/);
});

test("no last row means no staleness band at all — that case is the empty state", () => {
  assert.equal(stalenessWords({ behind: null, lastSha: null }), null);
});

test("the status line: distance in commits and the size of the history, nothing else", () => {
  // The head's one line. Both shas, the ages and the definition fold under it
  // (`stalenessWords` and `seriesSizeWords` above, unchanged), so it is pinned
  // to say neither — and to be absent exactly where the band is.
  const base = { lastSha: "a1b2c3d9f", lastDay: "2026-09-19", headSha: "e4f5a6b0c", rows: 84, days: 24 };
  assert.equal(seriesStatusWords({ ...base, behind: 0 }), "up to date · 84 commits measured over 24 days");
  assert.equal(seriesStatusWords({ ...base, behind: 3 }), "3 commits since the last reading · 84 commits measured over 24 days");
  assert.equal(seriesStatusWords({ ...base, behind: 1, rows: 1, days: 1 }), "1 commit since the last reading · 1 commit measured over 1 day");
  const unknown = seriesStatusWords({ ...base, behind: null });
  assert.match(unknown, /^could not tell how far behind · /);
  assert.doesNotMatch(unknown, /up to date|\b0 commits since/, "an unknown distance is never a zero");
  assert.equal(seriesStatusWords({ ...base, behind: 0, rows: 0 }), "up to date", "no size clause without rows");
  assert.equal(seriesStatusWords({ ...base, behind: 0, days: null }), "up to date · 84 commits measured");
  for (const s of [seriesStatusWords({ ...base, behind: 2 }), seriesStatusWords({ ...base, behind: 0 })]) {
    assert.doesNotMatch(s, /a1b2c3d|e4f5a6b|HEAD|definition|ago/, "the shas, ages and definition are the folded line's");
  }
  assert.equal(seriesStatusWords({ behind: 0, lastSha: null, rows: 84, days: 24 }), null);
});

test("HEAD is never given a calendar day", () => {
  // `tools/repohealth/git.mjs`: every day comes from `%ci`, the commit's own
  // offset, because 22 of 157 commits here are in the 22:00 hour. The wire
  // carries `head.ts` and no day for that reason, and inventing one from the
  // phone's clock is the same bug.
  const s = stalenessWords({ behind: 3, lastSha: "aaaaaaa", lastDay: "2026-09-19", headSha: "bbbbbbb" });
  assert.equal(s.match(/\d{4}-\d{2}-\d{2}/g).length, 1, "exactly one day, and it is the row's");
});

test("stale rows are a clause of their own, absent at zero", () => {
  assert.equal(staleRowsWords(0), null);
  assert.equal(staleRowsWords(null), null);
  const one = staleRowsWords(1);
  assert.match(one, /^1 row in the file measures a commit this repo no longer has/);
  assert.match(staleRowsWords(4), /^4 rows in the file measure a commit/);
  assert.match(one, /append-only/, "it says why they are not deleted");
});

test("the two ages are separate clauses, not folded into the commit distance", () => {
  assert.equal(narrativeWrittenWords("2h ago"), "narrative written 2h ago");
  assert.equal(lastCommitWords("14m ago"), "last commit 14m ago");
  const band = stalenessWords({ behind: 2, lastSha: "aaaaaaa", headSha: "bbbbbbb" });
  assert.doesNotMatch(band, /ago/, "an untouched repo is not stale; wall clock stays out of this number");
});

// ───────────────────────────────────────────────────────────────────────────
// The refresh control.
// ───────────────────────────────────────────────────────────────────────────

test("refreshLabel says which of the two taps this is", () => {
  assert.equal(refreshLabel(null), "build the series");
  assert.equal(refreshLabel(undefined), "build the series");
  assert.equal(refreshLabel({ rows: 0 }), "build the series");
  assert.equal(refreshLabel({ rows: 174 }), "update the series");
});

test("a running control says so, with the seconds", () => {
  assert.equal(refreshBusyLabel(null, 12_400), "building… 12 s");
  assert.equal(refreshBusyLabel({ rows: 174 }, 1_000), "updating… 1 s");
  assert.equal(refreshBusyLabel({ rows: 174 }, -5), "updating… 0 s");
});

test("durations read as durations", () => {
  assert.equal(msWords(18_432), "18.4 s");
  assert.equal(msWords(0), "0.0 s");
  assert.equal(msWords(125_000), "125 s");
});

test("the size of the series is stated, because every rank is a position in it", () => {
  assert.equal(seriesSizeWords({ rows: 174, days: 22, preregVersion: "2026-09-21c" }),
    "174 rows over 22 days, definition 2026-09-21c");
  assert.equal(seriesSizeWords({ rows: 1, days: 1, preregVersion: "2026-09-21c" }),
    "1 row over 1 day, definition 2026-09-21c");
  assert.equal(seriesSizeWords(null), null);
  assert.equal(seriesSizeWords({ rows: 0 }), null);
});

test("warnings and a request that never landed are their own sentences", () => {
  assert.equal(warningsWords([]), null);
  assert.equal(warningsWords(null), null);
  assert.equal(warningsWords(["no .myapp dir"]), "warning: no .myapp dir");
  assert.equal(warningsWords(["a", "b"]), "warnings: a · b");
});

test("a request that never landed blames the transport, not the repo", () => {
  // It read "the refresh could not be asked for: Failed to fetch" — a sentence
  // under this repo's heading, which reads as this repo's fault. Nothing ran
  // and nothing was read, and both have to be said or the reader takes what is
  // on screen for the answer to the tap.
  const s = refreshFailedWords("Failed to fetch");
  assert.match(s, /^the request did not reach the desktop: Failed to fetch\./);
  assert.match(s, /Nothing ran there/);
  assert.match(s, /nothing about this repo was read/);
});

test("a read the engine refused says what the engine said", () => {
  // A null series and silence is the picture of a repo nobody has measured
  // yet, which wants a tap on *build the series*. This wants a person to look
  // at the tree — so the engine's own sentence is printed whole.
  const s = readFailedWords("the repo-health engine exited 1: repohealth: not a git repository: /tmp/x.");
  assert.match(s, /not a git repository: \/tmp\/x\./, "verbatim — a paraphrase loses the path");
  assert.match(s, /Nothing was measured/);
});

// ───────────────────────────────────────────────────────────────────────────
// The mixed-version band: every version, every count, and the remedy verbatim.
// ───────────────────────────────────────────────────────────────────────────

const VERSIONS = [
  { version: "2026-09-21c", rows: 174 },
  { version: "2026-09-19a", rows: 41 },
  { version: "(unversioned)", rows: 3 },
];

test("one definition is not a band", () => {
  assert.equal(mixedVersionWords([{ version: "2026-09-21c", rows: 174 }], "2026-09-21c"), null);
  assert.equal(mixedVersionWords([], "2026-09-21c"), null);
  assert.equal(mixedVersionWords(null, "2026-09-21c"), null);
});

test("one OLD definition is the same refusal, predicted", () => {
  // packages/web's series was cut whole under +f7d42d0e; the engine moved to
  // +5b250243 and the first tap exited 3 with nothing on the sheet saying so.
  const recut = "rm /r/.waterplane/repohealth.x.jsonl && node /e/tools/repohealth.mjs update --root=/r";
  const s = mixedVersionWords([{ version: "2026-09-22a+f7d42d0e", rows: 121 }], "2026-09-22a+5b250243", recut);
  assert.ok(s.includes("2026-09-22a+f7d42d0e (121 rows)"), "the series' definition, with its rows");
  assert.ok(s.includes("2026-09-22a+5b250243"), "and the engine's");
  assert.match(s, /refuse/);
  assert.ok(s.includes(recut), "with the remedy");
  assert.equal(mixedVersionWords([{ version: "a", rows: 3 }], null, recut), null, "no engine version, no claim");
});

test("the band names EVERY version with its row count", () => {
  const s = mixedVersionWords(VERSIONS, "2026-09-21c");
  for (const v of VERSIONS) {
    assert.ok(s.includes(`${v.version}`), `${v.version} is named`);
    assert.ok(s.includes(`${v.version}${v.version === "2026-09-21c" ? " (current)" : ""}: ${v.rows} row`),
      `${v.version} carries its own row count — the count IS the evidence for the refusal`);
  }
  assert.ok(s.includes("(current)"), "and which one today's definition is");
});

// The engine's own re-cut line for the root it measured, off `measure.recut`.
// Absolute on both paths, because one engine reads every tree now.
const RECUT = "rm /Users/me/dev/drive-coach/.myapp/repohealth.jsonl && "
  + "node /Users/me/dev/myapp/tools/repohealth.mjs update --root=/Users/me/dev/drive-coach";

test("the band predicts the refusal and hands the remedy to the PERSON", () => {
  const s = mixedVersionWords(VERSIONS, "2026-09-21c", RECUT);
  assert.match(s, /refuse/, "said before the tap, not discovered by it");
  assert.match(s, /nothing here rewrites the file/);
  assert.ok(s.includes("at the desktop"), "the remedy is run there, not by this sheet");
  assert.ok(s.includes(RECUT), "and it is the ENGINE's own command for this root, verbatim");
});

test("with no command on the wire, none is printed", () => {
  // The constant this replaced was `rm .myapp/repohealth.jsonl && node
  // tools/repohealth.mjs update` — a relative path in whichever repo you are
  // in and a script most repos do not carry, so on a repo the desktop's
  // engine measured, both halves were wrong. The line begins with `rm`: a
  // guess is not offered, and the desktop is named as the thing that knows.
  const s = mixedVersionWords(VERSIONS, "2026-09-21c");
  assert.doesNotMatch(s, /\brm\b/, "no command at all, rather than one that deletes the wrong file");
  assert.doesNotMatch(s, /repohealth\.mjs/);
  assert.match(s, /ask the desktop for the command/);
});

// ───────────────────────────────────────────────────────────────────────────
// The outcome of the last run. A refusal is a ran-and-said-no.
// ───────────────────────────────────────────────────────────────────────────

test("a refusal is not worded as a failure", () => {
  const s = outcomeWords({ ok: false, ms: 1_200, step: "update", added: null,
    refused: { code: 3, text: "repohealth: refusing to append — …\n" } });
  assert.match(s, /ran and declined to append/);
  assert.match(s, /exit 3/);
  assert.doesNotMatch(s, /failed|error/i);
  assert.match(s, /in full/, "and points at the tool's own words, which are printed whole");
});

test("null added and zero added are opposite claims", () => {
  assert.match(outcomeWords({ ok: true, ms: 2_100, added: 0 }), /added no rows after 2\.1 s — the series already reached HEAD/);
  assert.match(outcomeWords({ ok: true, ms: 2_100, added: null }), /did not say how many rows/);
  assert.match(outcomeWords({ ok: true, ms: 18_400, added: 1 }), /added 1 row after 18\.4 s/);
  assert.match(outcomeWords({ ok: true, ms: 18_400, added: 7 }), /added 7 rows after 18\.4 s/);
});

test("an error carries the host's own sentence and the step it died at", () => {
  const s = outcomeWords({ ok: false, ms: 900, step: "narrate", added: null, refused: null,
    error: "tools/repohealth.mjs exited 1: ENOENT .myapp/repohealth.jsonl." });
  assert.ok(s.includes("at narrate"));
  assert.ok(s.includes("ENOENT .myapp/repohealth.jsonl."), "verbatim — a paraphrase loses the path");
});

test("a run in flight is an age, never a progress claim", () => {
  assert.equal(runningWords(null, 1_000), null);
  const s = runningWords({ startedAt: 1_000, note: "12/158 commits" }, 14_000);
  assert.equal(s, "a run is going on the desktop — started 13 s ago: 12/158 commits");
  assert.equal(runningWords({ startedAt: 1_000, note: null }, 4_000), "a run is going on the desktop — started 3 s ago");
});

// ───────────────────────────────────────────────────────────────────────────
// The absences this module owns. (The two for a repo with no tool are
// `repoHealthUnavailableText`'s, in shared, so one wording serves every
// surface — see the note at the top of repoHealthWords.ts.)
// ───────────────────────────────────────────────────────────────────────────

test("nothing measured yet says what the first run costs, in both currencies", () => {
  // The figures are the WIRE's: `measure.commits` for the job and
  // `stepTimeoutMs` for the cap. It used to say "about 20 seconds here",
  // which was one desktop reading one repo of 175 commits, on a screen that
  // now opens on repos of 1,329.
  const s = emptySeriesWords(1329, 180_000);
  assert.match(s, /1,329 first-parent commits/, "what it walks, at this repo's size");
  assert.match(s, /appended as it goes/, "so a run that runs out keeps what it measured");
  assert.match(s, /cap of 3 minutes on one step/, "the desktop's cap, off the wire");
  assert.match(s, /next tap carries on/, "and the timeout is one more tap, not a dead end");
  assert.match(s, /spends no tokens/, "and what it costs on a rate-limited plan, which is nothing");
  assert.doesNotMatch(s, /20 seconds/);
});

test("a first run on an older desktop names no number it was not told", () => {
  // `measure` is null on a worktree carrying an engine that predates the
  // field, and `stepTimeoutMs` can be absent on an older host. A figure
  // invented here would be a fact about this desktop printed about another.
  const s = emptySeriesWords(null, null);
  assert.match(s, /walks every first-parent commit in this repo/);
  assert.match(s, /this desktop's cap on one step/);
  assert.doesNotMatch(s, /\d/, "no number at all, rather than a number nobody measured");
});

test("the head names no file, because most repos do not have one", () => {
  // "measured by tools/repohealth.mjs" named a path twelve of the thirteen
  // repos on this desktop do not carry. WHICH engine read this tree is
  // `engineLineWords`, which can name either.
  assert.doesNotMatch(seriesHeadWords(), /repohealth\.mjs/);
  assert.match(seriesHeadWords(), /One row per first-parent commit/);
  assert.match(seriesHeadWords(), /spends no tokens/);
});

test("the engine and its packs are named, which is what makes an absence legible", () => {
  // Live, 2026-09-21: drive-coach, read by the desktop's engine.
  const s = engineLineWords({
    kind: "bundled",
    version: "2026-09-21e+0fb8561e",
    packs: [{ name: "common", files: 0 }, { name: "kotlin", files: 88 }],
  });
  assert.match(s, /this desktop's engine, pointed at the worktree/);
  assert.match(s, /version 2026-09-21e\+0fb8561e/);
  assert.match(s, /packs common 0, kotlin 88/, "the counts are the denominator of every absence");
  assert.match(s, /extension census's count/, "and the zero has an owner, or it reads as a pack that found nothing");

  // A repo carrying its own copy is a different fact: the two can be
  // different versions, and a reading that moved because the engine changed
  // is not one that moved because the code did.
  assert.match(engineLineWords({ kind: "repo", version: "2026-09-21e+c27d320f" }),
    /this repo's own copy of the engine/);

  // Separately absent, all the way down to nothing at all.
  assert.match(engineLineWords({ kind: "bundled" }), /^read by this desktop's engine/);
  assert.equal(engineLineWords({ kind: null }), null);
  assert.equal(engineLineWords({}), null);
  // A pack that did not count is not a pack that counted nothing, and an
  // empty LIST is a measurement rather than silence.
  assert.match(engineLineWords({ kind: "repo", packs: [{ name: "dart", files: null }] }), /dart \(no count\)/);
  assert.match(engineLineWords({ kind: "repo", packs: [] }), /named no language pack/);
});

test("a repo the engine recognised nothing in SAYS so, instead of printing `common 0`", () => {
  // The reachable state, and the one this line got wrong. The empty-list
  // branch above cannot happen — the always-on pack is in every census — so
  // what a repo with no recognised language actually shows is one pack at
  // zero, and `packs common 0` reads as a pack that looked and found nothing.
  // Live: `node tools/repohealth.mjs --root=~/dev/smoke status` prints exactly
  // `packs: [{ name: "common", version: "1", files: 0 }]`.
  const s = engineLineWords({ kind: "bundled", version: "2026-09-21e", packs: [{ name: "common", files: 0 }] });
  assert.match(s, /no language pack reads this tree's source/);
  // The pack is still NAMED — the reader has to be able to see what was
  // active — and the census legend is gone with the figures it explained.
  assert.match(s, /common is active and claims no file extension/);
  assert.doesNotMatch(s, /packs common 0/);
  assert.doesNotMatch(s, /extension census's count/);
  // It is read off the COUNTS, not off the name: one pack that counted files
  // is a tree the engine reads, however small the count.
  assert.match(
    engineLineWords({ kind: "bundled", packs: [{ name: "common", files: 0 }, { name: "shell", files: 3 }] }),
    /packs common 0, shell 3/,
  );
  // A pack that did not COUNT is not a pack that counted zero, so it never
  // lands in the "nothing here" sentence.
  assert.match(
    engineLineWords({ kind: "bundled", packs: [{ name: "common", files: 0 }, { name: "dart", files: null }] }),
    /packs common 0, dart \(no count\)/,
  );
});

// The sheet no longer has a button to that page — it draws every card the
// page has. The sentence that replaced the button has to name the file in
// FULL, which is this repo's rule for a transport path: a bare filename does
// not resolve for a reader, and this one is the only pointer left.
test("the desktop copy is named in full, as a sentence and not a control", () => {
  assert.match(drawnPageWords(true), /\.claude\/outbox\/repohealth\.html/);
  // …and the page the html step has not written yet is a different sentence,
  // not the same one with a file that is not there.
  assert.match(drawnPageWords(false), /\.claude\/outbox\/repohealth\.html is not written yet/);
  assert.doesNotMatch(drawnPageWords(false), /Nothing on it is missing/);
});

// ───────────────────────────────────────────────────────────────────────────
// The narrative split — against a checked-in sample of the tool's own shape,
// and against the real document only when this checkout has one.
// ───────────────────────────────────────────────────────────────────────────

// What `tools/repohealth/narrate.mjs` writes: its HEADER-shaped preamble, then
// one `## YYYY-MM-DD` section per day, oldest first. Checked in, because the
// live file is gitignored plumbing — absent on a fresh clone, and whatever a
// running host last left in it — so it cannot be the only evidence of a rule.
const SAMPLE = [
  "# Repo health — .claude/outbox/repohealth.md",
  "",
  "A colleague who reads `git log` so you do not have to.",
  "",
  "## 2026-06-19",
  "",
  "- the always-on context reading is back after 1 reading without one.",
  "",
  "## 2026-09-12",
  "",
  "- 4 names lost their last caller — 128 orphaned names in the tree, 116 on 2026-09-11.",
  "",
  "## 2026-09-21",
  "",
  "- 2 names lost their last caller — 185 orphaned names in the tree, 179 on 2026-09-20.",
  "- tsIgnore: `@ts-ignore\\b` went 0 → 1 occurrences.",
  "",
  "## 2026-09-25",
  "",
  "- escape hatches per kLOC is 1.34, was 1.27 on 2026-09-24.",
  "",
].join("\n");

/** The live file, or null with the reason — a skip, never a pass. */
function liveNarrative(t) {
  let md;
  try {
    md = readFileSync(NARRATIVE, "utf8");
  } catch {
    t.skip(`${NARRATIVE} is not on this checkout (it is gitignored plumbing)`);
    return null;
  }
  if (!/^## \d{4}-\d{2}-\d{2}$/m.test(md)) {
    t.skip(`${NARRATIVE} has no day in it yet`);
    return null;
  }
  return md;
}

/** The ordering rule, asserted once for every text it is checked against. */
function assertDaysInOrder(md) {
  const { days } = splitNarrativeDays(md);
  assert.ok(days.length > 0);
  for (const d of days) assert.match(d.day, /^\d{4}-\d{2}-\d{2}$/);
  const sorted = [...days].map((d) => d.day).sort();
  assert.deepEqual(days.map((d) => d.day), sorted, "oldest first, as written — the sheet reverses for the draw");
  assert.equal(new Set(sorted).size, sorted.length, "one section per day");
  assert.ok(days[0].body.includes("\n"), "the body keeps its leading newline so a re-join is exact");
}

function assertRoundTrip(md) {
  const split = splitNarrativeDays(md);
  assert.match(split.preamble, /^# Repo health/, "the standing explanation is the preamble");
  assert.doesNotMatch(split.preamble, /^## /m, "and holds no day");
  assert.equal(joinNarrativeDays(split), md, "nothing the tool wrote is dropped by showing it");
}

test("splitting a narrative round-trips byte for byte", () => {
  assertRoundTrip(SAMPLE);
  assert.equal(splitNarrativeDays(SAMPLE).days.length, 4);
});

test("days come back in FILE order, with their headings parsed", () => {
  assertDaysInOrder(SAMPLE);
  const { days } = splitNarrativeDays(SAMPLE);
  assert.deepEqual(days.map((d) => d.day), ["2026-06-19", "2026-09-12", "2026-09-21", "2026-09-25"]);
  // FILE order, not sorted order: a file out of order comes back out of order,
  // which is what makes the check above a check on the WRITER.
  const swapped = joinNarrativeDays({ preamble: "", days: [days[2], days[0]] });
  assert.deepEqual(splitNarrativeDays(swapped).days.map((d) => d.day), ["2026-09-21", "2026-06-19"]);
});

test("the real narrative, where this checkout has one, round-trips and is in order", (t) => {
  const md = liveNarrative(t);
  if (md === null) return;
  assertRoundTrip(md);
  assertDaysInOrder(md);
});

test("a text that starts with a day has no preamble, and still round-trips", () => {
  const src = "## 2026-09-20\n\n- a thing moved.\n\n## 2026-09-21\n\n- another.\n";
  const split = splitNarrativeDays(src);
  assert.equal(split.preamble, "");
  assert.deepEqual(split.days.map((d) => d.day), ["2026-09-20", "2026-09-21"]);
  assert.equal(joinNarrativeDays(split), src);
});

test("a narrative with no days at all is all preamble", () => {
  const src = "# Repo health\n\nNothing yet.\n";
  assert.deepEqual(splitNarrativeDays(src), { preamble: src, days: [] });
  assert.equal(joinNarrativeDays(splitNarrativeDays(src)), src);
});

// ───────────────────────────────────────────────────────────────────────────
// The rule the whole module exists to keep.
// ───────────────────────────────────────────────────────────────────────────

test("no verdict word appears in anything this module can produce", () => {
  const everything = [
    emptySeriesWords(1329, 180_000), emptySeriesWords(null, null),
    seriesHeadWords(),
    engineLineWords({ kind: "bundled", version: "v", packs: [{ name: "kotlin", files: 88 }] }),
    engineLineWords({ kind: "repo", packs: [] }),
    readFailedWords("the repo-health engine exited 1: repohealth: not a git repository: /tmp/x."),
    drawnPageWords(true), drawnPageWords(false),
    refreshLabel(null), refreshLabel({ rows: 174 }),
    refreshBusyLabel(null, 12_000), refreshBusyLabel({ rows: 174 }, 12_000),
    msWords(18_400),
    narrativeWrittenWords("2h ago"), lastCommitWords("14m ago"),
    staleRowsWords(1), staleRowsWords(4),
    stalenessWords({ behind: 2, lastSha: "aaaaaaa", lastDay: "2026-09-19", headSha: "bbbbbbb" }),
    stalenessWords({ behind: 0, lastSha: "aaaaaaa", lastDay: "2026-09-19", headSha: "aaaaaaa" }),
    stalenessWords({ behind: null, lastSha: "aaaaaaa", lastDay: "2026-09-19", headSha: null }),
    seriesStatusWords({ behind: 2, lastSha: "aaaaaaa", rows: 84, days: 24 }),
    seriesStatusWords({ behind: 0, lastSha: "aaaaaaa", rows: 84, days: 24 }),
    seriesStatusWords({ behind: null, lastSha: "aaaaaaa", rows: 84, days: 24 }),
    mixedVersionWords(VERSIONS, "2026-09-21c"),
    mixedVersionWords(VERSIONS, "2026-09-21c", RECUT),
    outcomeWords({ ok: true, ms: 18_400, added: 7 }),
    outcomeWords({ ok: true, ms: 2_100, added: 0 }),
    outcomeWords({ ok: true, ms: 2_100, added: null }),
    outcomeWords({ ok: false, ms: 900, step: "narrate", added: null, error: "it broke." }),
    outcomeWords({ ok: false, ms: 1_200, step: "update", added: null, refused: { code: 3, text: "x" } }),
    runningWords({ startedAt: 0, note: "1/158 commits" }, 5_000),
    seriesSizeWords({ rows: 174, days: 22, preregVersion: "2026-09-21c" }),
    warningsWords(["a", "b"]),
    refreshFailedWords("timeout"),
    ...Object.values(KPI_MEANING),
    rankChipWords({ rank: 0.38, n: 24, slope: "falling" }),
    tileWords.TILE_FOLD_LABEL, tileWords.TILES_MORE_SUMMARY, tileWords.OWN_MORE_SUMMARY,
    tileWords.tileToggleTitle("p95 file size", false), tileWords.tileToggleTitle("p95 file size", true),
    tileWords.areaAbsentWords({ areas: {}, absent: "x" }), tileWords.areaAbsentWords({ areas: {}, areasAbsent: "y" }),
  ].join("\n");

  // The same list `tools/repohealth.test.mjs` holds the narrative to, plus the
  // two comparatives a phone reaches for that prose does not.
  for (const word of ["score", "grade", "healthy", "unhealthy", "good", "bad", "should", "worse", "better"]) {
    assert.doesNotMatch(
      everything,
      new RegExp(`\\b${word}\\b`, "i"),
      `"${word}" is a verdict. This sheet reads and reports; the tool it reads holds no opinion, and a screen that adds one is the tool's own test defeated by moving the sentence.`,
    );
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Region 2: the series as charts.
// ───────────────────────────────────────────────────────────────────────────

const {
  SERIES_ASK_ALL_LABEL, SERIES_ASK_LABEL,
  areaRowWords,
  areaSpreadWords,
  bothClocksWords,
  mixedPlotWords,
  notPlottedWords,
  notesSummaryWords,
  plotAxisModeWords,
  plotAxisWords,
  rankBasisWords,
  rankSentence,
  readingsTableWords,
  regionWords,
  seriesAskNoteWords,
  seriesValueWords,
  slopeWords,
  tileAbsentWords,
} = await import("./repoHealthWords.ts");

// The other half of region 2's prose — the captions under the things that are
// NOT readings. A separate module since `repoHealthWords.ts` hit the line cap,
// and held to the identical rules: the verdict-word ban below runs over both,
// because a judgement is no more allowed under a magnitude than under a rank.
const {
  TYPE_FILTER_CLEAR,
  depsWords,
  holderWords,
  longestCaptionWords,
  longestPickWords,
  magnitudeLeadWords,
  magnitudesNoteWords,
  packageStackWords,
  tapeWords,
  typeChipWords,
  typeFilterWords,
  typeStackWords,
  typesAbsentWords,
  weightStackWords,
} = await import("./repoHealthStackWords.ts");

test("a rank is read off the wire as a fraction and printed once, as a percentile", () => {
  // The real reading for `size.p95` at bba067c.
  const s = rankSentence({ rank: 0.8864, slope: "rising", n: 22, from: "2026-06-18" });
  assert.equal(s, "89th percentile of the last 22 readings back to 2026-06-18, rising");
});

test("the ordinal is right where English is not regular", () => {
  const at = (rank) => rankSentence({ rank, n: 100, from: "d" }).split(" ")[0];
  assert.equal(at(0.01), "1st");
  assert.equal(at(0.02), "2nd");
  assert.equal(at(0.03), "3rd");
  assert.equal(at(0.11), "11th");
  assert.equal(at(0.12), "12th");
  assert.equal(at(0.13), "13th");
  assert.equal(at(0.21), "21st");
});

test("a null rank is the tool's own reason, and never a 0th percentile", () => {
  // The two are opposite claims: too little history to place the value, versus
  // the lowest value ever recorded. This is the real reading for CLAUDE.md,
  // whose series starts at 2026-09-11.
  const s = rankSentence({ rank: null, slope: null, n: 8, from: "2026-09-11", reason: "not enough history (8 of 14 readings)" });
  assert.equal(s, "not enough history (8 of 14 readings)");
  assert.doesNotMatch(s, /percentile/);
  assert.doesNotMatch(s, /\b0th\b/);
});

test("a null rank with no reason still refuses to invent a position", () => {
  const s = rankSentence({ rank: null, n: 3 });
  assert.match(s, /not enough history \(3 readings\)/);
  assert.doesNotMatch(s, /percentile/);
});

test("a value is printed in the shape its own unit needs", () => {
  assert.equal(seriesValueWords(1352, "lines"), "1,352 lines");
  assert.equal(seriesValueWords(11955, "chars"), "11,955 chars");
  // A rate rounded to a whole number is the reading deleted.
  assert.equal(seriesValueWords(0.6944444444444444), "0.69");
  assert.equal(seriesValueWords(1.0406772084706934), "1.04");
  assert.equal(seriesValueWords(176), "176");
  assert.equal(seriesValueWords(null), "—");
  assert.equal(seriesValueWords(undefined, "lines"), "—");
});

test("each absence is its own sentence, and none of them is a blank box", () => {
  assert.match(tileAbsentWords({ absent: "no source files at this commit" }), /not taken on the latest day — no source files/);
  assert.match(tileAbsentWords({ readings: 0 }), /no reading in the whole series/);
  assert.match(tileAbsentWords({ readings: 1, minToDraw: 2 }), /^1 reading in the series — a curve needs 2/);
  assert.equal(tileAbsentWords({ readings: 22, minToDraw: 2 }), null);
});

test("the axis caption says the x axis is not a calendar", () => {
  const s = plotAxisWords(22, "2026-06-18", "2026-09-21");
  assert.match(s, /POSITION in the series and not by date/);
  assert.match(s, /cuts the line rather than joining across it/);
  assert.match(s, /fitted to its own/);
  assert.match(s, /2026-06-18 to 2026-09-21/);
  // The ticks are dates now, which is exactly why the caption has to say what
  // kind of axis they are on: three dates under an evenly spaced curve read
  // as a calendar unless told otherwise.
  assert.match(s, /days AT those positions/);
  // "no TILE starts at zero", not "nothing here": three captions further down
  // the same region draws the stack, which is zero-based on purpose and
  // prints the zero. A caption that contradicts a chart on the same screen is
  // worse than no caption.
  assert.match(s, /NO TILE STARTS AT ZERO/);
  assert.match(s, /stacked chart[\s\S]*exception/);
  // Neither count is promised: a two-reading series gets two ticks and a flat
  // series gets one y label.
  assert.doesNotMatch(s, /three dates|two figures/);
});

test("the rank window is quoted off the wire, never written down here", () => {
  const s = rankBasisWords(60, 14);
  assert.match(s, /last 60 readings/);
  assert.match(s, /below 14/);
});

test("a slope is a word and nothing else", () => {
  assert.equal(slopeWords("rising"), "rising");
  assert.equal(slopeWords(null), null);
  assert.equal(slopeWords(undefined), null);
});

test("the context-weight row prints both clocks and reconciles neither", () => {
  // The measured pair at bba067c: 11,955 + 10,146 = 22,101 chars, against a
  // working tree that has moved since.
  const s = bothClocksWords(22_400, 22_101, "bba067c");
  assert.match(s, /22,400 in the working tree/);
  assert.match(s, /22,101 at bba067c/);
  assert.match(s, /two clocks on one number/);
  // No average, no preference, no hidden gap.
  assert.doesNotMatch(s, /22,250|averag/i);
});

test("with no working-tree NUMBER on the wire, the clause points at the sentence above", () => {
  // The checklist states that figure inside the row's own prose and nowhere as
  // a field. Prising it back out with a regex is a parser nobody would notice
  // breaking, so the clause names where it is instead of repeating it.
  const s = bothClocksWords(null, 22_101, "bba067c");
  assert.match(s, /22,101 at bba067c/);
  assert.match(s, /the sentence above is the same number in the working tree/);
  assert.match(s, /Two clocks, left as they are/);
});

test("and with no series reading, the working tree stands alone and says so", () => {
  assert.match(bothClocksWords(22_400, null, "bba067c"), /the series has no reading of it to sit beside/);
  assert.equal(bothClocksWords(null, null, "bba067c"), null);
});

test("an area with no sub-skills says its two ends are one number", () => {
  // `shared` really is this: expected === ceiling === p90, subs 0.
  const s = areaRowWords({ expected: 44980, ceiling: 44980, p90: 44980, commits: 48, subs: 0 });
  assert.match(s, /no sub-skills, so the two ends are one number/);
  const web = areaRowWords({ expected: 59318, ceiling: 135732, p90: 84145, commits: 86, subs: 7 });
  assert.match(web, /usually 59,318 chars · up to 135,732/);
  assert.match(web, /7 sub-skills/);
});

test("an area nobody has touched has no usual load, rather than a zero", () => {
  const s = areaRowWords({ expected: null, ceiling: 40_000, p90: null, commits: 0, subs: 2 });
  assert.match(s, /no commit has touched this area yet/);
  assert.doesNotMatch(s, /usually 0/);
});

test("an area that can never be attributed says the metric's reason, not this one's guess", () => {
  // Two ways to have no `expected`, and they were printing as one. An area
  // whose router description names no source group has no commit attributable
  // to it EVER — "no commit has touched this area yet" is simply false there,
  // and it is the sentence that invites waiting for one. The metric states
  // which case it is; this only ever sees the nulls.
  const reason = "the myapp-host description names no source group, so no commit can be attributed to it";
  const s = areaRowWords({ expected: null, ceiling: 122_288, p90: null, commits: null, subs: 7, reason });
  assert.match(s, /names no source group/);
  assert.doesNotMatch(s, /no commit has touched this area yet/);
  // The numbers it DOES have still print: the ceiling is a real reading of
  // the tree even where nothing can be attributed.
  assert.match(s, /up to 122,288/);
  assert.match(s, /7 sub-skills/);
  // And a reason never displaces a reading it does not explain.
  const read = areaRowWords({ expected: 59_318, ceiling: 135_732, p90: null, commits: 86, subs: 7, reason });
  assert.match(read, /usually 59,318 chars/);
  assert.doesNotMatch(read, /names no source group/);
});

test("the magnitudes lead is absent rather than zeroed", () => {
  assert.equal(magnitudeLeadWords(325, 143_176), "325 source files · 143,176 lines");
  assert.match(magnitudeLeadWords(null, 143_176), /an unread file count/);
  assert.equal(magnitudeLeadWords(null, null), null);
});

test("the tape's two figures are words, because a dashed rule means a threshold", () => {
  const { lead, more } = tapeWords(50, 16_236, 1_352, 325);
  assert.match(lead, /longest 16,236 lines/);
  assert.match(lead, /p95 1,352 lines/);
  assert.match(lead, /the other 275 files in the tree are not in this row/);
  // WHY they are words folds: a reason about the drawing, not a reading.
  assert.doesNotMatch(lead, /dashed/);
  assert.match(more, /a dashed line means a threshold on every other chart here/);
  // The tape's length is the tool's decision; no cap is written down here, so
  // an uncapped tape says nothing about a rest that does not exist.
  assert.doesNotMatch(tapeWords(325, 16_236, 1_352, 325).lead, /not in this row/);
  assert.doesNotMatch(tapeWords(50, 16_236, 1_352, null).lead, /not in this row/);
  // The longest file's PATH, when the wire carries one: a length nobody can
  // act on becomes a file somebody can open, and it is the figure the drawn
  // HTML page had and this screen did not.
  assert.match(tapeWords(50, 16_236, 1_352, 325, "packages/web/src/App.tsx").lead, /longest 16,236 lines — packages\/web\/src\/App\.tsx/);
  // A name with no length is nothing to hang it on, so the clause is the
  // length's and never its own — which is also how the longest is said ONCE:
  // with the tile's value line above the tape, the caller passes no length.
  const once = tapeWords(50, null, 1_352, 325, "packages/web/src/App.tsx");
  assert.doesNotMatch(once.lead, /App\.tsx|longest \d/);
  assert.match(once.lead, /p95 1,352 lines/);
  assert.match(once.more, /Neither the longest file nor p95/, "the reason still names both figures");
});

test("the dependency count says what it is not counting", () => {
  assert.match(depsWords(13), /13 production dependencies/);
  assert.match(depsWords(13), /dev dependencies are a separate count/);
  assert.match(depsWords(1), /1 production dependency/);
  assert.equal(depsWords(null), null);
});

test("what is not plotted is said, with its reason", () => {
  const s = notPlottedWords();
  assert.match(s, /tripwires/);
  assert.match(s, /events on one day/);
  assert.match(s, /co-change/);
  assert.match(s, /without a rank/);
});

test("a mixed series is still drawn, and the caption says so", () => {
  const s = mixedPlotWords([{ version: "a", rows: 3 }, { version: "b", rows: 5 }]);
  assert.match(s, /plot the rows as they are on disk, under 2 definitions/);
  assert.match(s, /refusing to draw would remove the only view of the problem/);
  assert.equal(mixedPlotWords([{ version: "a", rows: 3 }]), null, "one definition is not a mixed series");
  assert.equal(mixedPlotWords(null), null);
});

test("the two regions are told apart by their COMPARATOR, not by time", () => {
  const setup = regionWords("setup");
  const series = regionWords("series");
  assert.match(setup, /a line somebody chose/);
  assert.match(setup, /what the badge counts/);
  assert.match(series, /its own past/);
  assert.match(series, /no side to be on/);
  assert.match(series, /nothing here has a status, a colour or a place in the badge/);
});

test("the series verb opens a prompt and says it sends nothing", () => {
  // It names the QUESTION, not the recipient. "ask the agent about this" said
  // who would be asked and nothing about what, over a prompt that opened with
  // "explain what is behind this reading" — so what came back was an
  // explanation of the measurement, and the person typed their real question
  // again by hand.
  assert.equal(SERIES_ASK_LABEL, "ask if this is serving the repo");
  const s = seriesAskNoteWords();
  assert.match(s, /Nothing is sent by the tap/);
  assert.match(s, /nothing offers a fix/);
  assert.match(s, /the thing the reading is OF/, "the note says what the prompt is about, or it describes the old one");
  assert.match(s, /Leaving it alone is one of the answers/);
});

test("the second verb is the set's, and the note says what it carries", () => {
  // Two verbs on one screen have to differ by more than their size, or the
  // reader has no way to tell which question they are asking. The note is
  // where that difference is stated: the row's carries its one reading, the
  // set's carries all of them INCLUDING the absences, which is the whole
  // reason the second one exists.
  // It refers BACK to the row's verb rather than phrasing the question its own
  // way: two labels each wording it separately are two questions, drifting
  // apart at the next edit.
  assert.equal(SERIES_ASK_ALL_LABEL, "ask this of all of them");
  const s = seriesAskNoteWords();
  assert.match(s, /carries every reading at once/);
  assert.match(s, /absences and their reasons/);
  assert.match(s, /move for the same reason/);
});

test("no verdict word appears anywhere in region 2 either", () => {
  const everything = [
    regionWords("setup"), regionWords("series"),
    rankSentence({ rank: 0.8864, slope: "rising", n: 22, from: "2026-06-18" }),
    rankSentence({ rank: 0.0227, slope: "falling", n: 22, from: "2026-06-18" }),
    rankSentence({ rank: 0.5, slope: "flat", n: 22, from: "2026-06-18" }),
    rankSentence({ rank: null, n: 8, from: "2026-09-11", reason: "not enough history (8 of 14 readings)" }),
    slopeWords("rising"), slopeWords("falling"), slopeWords("flat"),
    seriesValueWords(1352, "lines"), seriesValueWords(0.694),
    tileAbsentWords({ absent: "no source files at this commit" }),
    tileAbsentWords({ readings: 0 }),
    tileAbsentWords({ readings: 1, minToDraw: 2 }),
    plotAxisWords(22, "2026-06-18", "2026-09-21"),
    ...Object.values(plotAxisModeWords("weeks", 14, "2026-06-18", "2026-09-21")),
    ...Object.values(plotAxisModeWords("commits", 1, null, null)),
    notesSummaryWords(1), notesSummaryWords(12),
    axisModeWords("weeks"), axisModeWords("commits"),
    thinnedWords(142, 1526) ?? "", commitsAbsentWords("waterplane"), REGION_SCRUB_HINT,
    rankBasisWords(60, 14),
    bothClocksWords(22_400, 22_101, "bba067c"),
    bothClocksWords(22_400, null, null),
    weightStackWords(),
    areaSpreadWords(),
    areaRowWords({ expected: 52174, ceiling: 109583, p90: 76401, commits: 54, subs: 6 }),
    areaRowWords({ expected: null, ceiling: null, p90: null, commits: 0, subs: 0 }),
    magnitudeLeadWords(325, 143_176),
    magnitudesNoteWords(),
    packageStackWords(),
    ...Object.values(tapeWords(50, 16_236, 1_352, 325)),
    ...Object.values(tapeWords(50, 16_236, 1_352, 325, "packages/web/src/App.tsx")),
    depsWords(13),
    longestPickWords({ day: "2026-09-22", sha7: "683bffa", v: 16351 }, "packages/web/src/App.tsx", true),
    longestPickWords({ day: "2026-09-22", v: 16351 }, null, true),
    holderWords({ path: "packages/web/src/App.tsx", readings: 23 }, "2026-06-18", "2026-09-22", 23),
    holderWords({ path: "src/a.ts", readings: 3 }, "2026-06-18", "2026-06-21", 23),
    ...Object.values(longestCaptionWords({ handovers: 0, folded: 0, unnamed: false, named: true })).filter(Boolean),
    ...Object.values(longestCaptionWords({ handovers: 3, folded: 1, unnamed: true, named: true })).filter(Boolean),
    ...Object.values(longestCaptionWords({ handovers: 0, folded: 0, unnamed: true, named: false })).filter(Boolean),
    notPlottedWords(),
    readingsTableWords(14, 157),
    mixedPlotWords([{ version: "a", rows: 3 }, { version: "b", rows: 5 }]),
    SERIES_ASK_LABEL, SERIES_ASK_ALL_LABEL,
    typeStackWords(), typesAbsentWords(), TYPE_FILTER_CLEAR,
    typeFilterWords(4, 11, 121_204, 217_021) ?? "", typeFilterWords(11, 11, 217_021, 217_021) ?? "",
    typeChipWords(".kt", "kotlin", 63_100), typeChipWords(".mjs", null, null),
    seriesAskNoteWords(),
    // The axis and crosshair sentences are region-2 strings like any other,
    // and they were outside this list for one commit. A readout is exactly
    // where a verdict would be easiest to slip in — it is the sentence that
    // appears when somebody points at a number.
    axisDayWords("2026-06-18"), axisDayWords("whatever"),
    SCRUB_HINT,
    pointReadoutWords({ day: "2026-08-16", sha7: "3e9f1a2", v: 1352 }, "lines"),
    pointReadoutWords({ day: "2026-08-16", sha7: "3e9f1a2", v: null }, "lines"),
    stackReadoutWords(
      { day: "2026-09-19", sha7: "aa11bb2" },
      [{ label: "CLAUDE.md", v: 11955 }, { label: "skill descriptions", v: 10146 }],
      22101, "chars",
    ),
    stackReadoutWords(
      { day: "2026-09-19" },
      [{ label: "CLAUDE.md", v: 11955 }, { label: "skill descriptions", v: null }],
      null, "chars",
    ),
  ].join("\n");

  for (const word of ["score", "grade", "healthy", "unhealthy", "good", "bad", "should", "worse", "better", "improve", "regress"]) {
    assert.doesNotMatch(
      everything,
      new RegExp(`\\b${word}\\b`, "i"),
      `"${word}" is a verdict. A reading compared to its own past has no side to be on, and a chart is ` +
      `where a verdict hides best: this is the same ban the tool's own test applies to the narrative.`,
    );
  }
});

test("and nothing in region 2 names a status colour", () => {
  // The other half of the same rule. `--warn` and `--dead` mean "a line was
  // crossed"; there is no line here, so a token that carries one must not be
  // reachable from a sentence.
  const src = readFileSync(fileURLToPath(new URL("./repoHealthWords.ts", import.meta.url)), "utf8");
  for (const token of ["--warn", "--dead", "--limit", "--ok"]) {
    assert.ok(!src.includes(token), `${token} is a status colour; region 2 has no status to carry.`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// The axes and the crosshair: a mark a person can check.
// ───────────────────────────────────────────────────────────────────────────

test("a tick is a short day, in a spelling that does not move with the device", () => {
  assert.equal(axisDayWords("2026-06-18"), "18 Jun");
  assert.equal(axisDayWords("2026-09-01"), "1 Sep");
  // No `toLocaleDateString`: a locale that spells out "September" overlaps
  // its neighbour in a 40-px space, silently, only on that phone.
  assert.ok(!axisDayWords("2026-09-01").includes("September"));
});

test("a day the tick cannot parse comes back verbatim, never blank", () => {
  assert.equal(axisDayWords("whenever"), "whenever");
  assert.equal(axisDayWords("2026-13-40"), "2026-13-40", "a month that does not exist is not month 13");
  assert.equal(axisDayWords(null), "");
  assert.equal(axisDayWords(undefined), "");
});

test("the crosshair names the day, the value AND the tree it was read from", () => {
  const s = pointReadoutWords({ day: "2026-08-16", sha7: "3e9f1a2", v: 1352 }, "lines");
  assert.equal(s, "2026-08-16 · 1,352 lines · 3e9f1a2");
  // The sha is the difference between a chart and a claim: every point is one
  // commit, and a reading a person can check out is one they can argue with.
  assert.ok(s.includes("3e9f1a2"));
});

test("a rate keeps its decimals under the crosshair too", () => {
  assert.match(pointReadoutWords({ day: "2026-08-16", v: 0.694 }, ""), /0\.69/);
  assert.equal(pointReadoutWords(null), null);
});

test("a point with no value says so rather than printing a dash nobody can read", () => {
  const s = pointReadoutWords({ day: "2026-08-16", sha7: "abc1234", v: null }, "lines");
  assert.match(s, /no reading that day/);
  assert.ok(!s.includes("0 lines"), "an unread day is never a zero");
});

test("the stack's readout leads with the total, then its split", () => {
  const s = stackReadoutWords(
    { day: "2026-09-19", sha7: "aa11bb2" },
    [{ label: "CLAUDE.md", v: 11955 }, { label: "skill descriptions", v: 10146 }],
    22101,
    "chars",
  );
  // The chart's own claim is that the top edge is the total and the bands are
  // its split; a readout that listed the parts first would be a second,
  // different reading of the same mark.
  assert.ok(s.indexOf("22,101") < s.indexOf("11,955"));
  assert.match(s, /CLAUDE\.md 11,955/);
  assert.match(s, /skill descriptions 10,146/);
  assert.match(s, /aa11bb2$/);
});

test("a missing term in a sum is printed, never silently dropped", () => {
  const s = stackReadoutWords(
    { day: "2026-09-19" },
    [{ label: "CLAUDE.md", v: 11955 }, { label: "skill descriptions", v: null }],
    null,
    "chars",
  );
  assert.match(s, /no total that day/);
  assert.match(s, /skill descriptions not read/);
  assert.ok(!s.includes("skill descriptions 0"));
});

test("the readout line says how to use it before anything is touched", () => {
  // There is no hover on a phone, so a crosshair nobody is told about is a
  // crosshair nobody finds.
  // The tiles draw the kit's one wording (`SCRUB_HINT`): it was spelled three ways
  // on three charts (here, the context sheet, the limit windows), which reads as
  // three gestures. It lives in the kit, not in these pure slices, because the
  // slices import only each other (webclientpins).
  assert.match(SCRUB_HINT, /drag/);
});

test("the magnitudes say they are not readings, so a missing rank reads as the point", () => {
  const s = magnitudesNoteWords();
  assert.match(s, /not readings/);
  assert.match(s, /no percentile/);
  // A reader who has just learnt every number here carries a rank will look
  // for the missing one and take its absence for a gap in the data.
  assert.match(s, /percentiles OF/);
});

test("the source-group stack says its top edge IS the total, and calls a band a group", () => {
  const s = packageStackWords();
  assert.match(s, /top edge is the whole tree/);
  assert.match(s, /no separate total/);
  // Colour follows the entity, never its size today — the rule `foldPartSeries`
  // encodes, said where a reader can check it against the picture.
  assert.match(s, /follows a group and not its size/);
  assert.match(s, /fold into one band/);
  // A band is a SOURCE GROUP. On this repo the groups include `tools`,
  // `deploy` and `.`; on a Flutter tree not one of them is a package. The
  // wire field is still called `packages`; the sentence says what it is, and
  // says out loud that it is not the thing it used to claim.
  assert.match(s, /Lines of source per group/);
  assert.match(s, /not necessarily a package/);
  assert.doesNotMatch(s, /per package|Past four packages/);
});

test("the per-type chart says the filter changed what the top edge means", () => {
  // A stack's top edge is the whole on every other chart in this region. With
  // a type switched off it is not, and that has to be said in the caption
  // rather than left to be inferred from a shorter bar.
  const cut = typeFilterWords(4, 11, 121_204, 217_021);
  assert.match(cut, /4 of 11 types/);
  assert.match(cut, /121,204 of 217,021 lines/);
  assert.match(cut, /The top edge is those 4, not the tree/);
  // Nothing filtered is not a state to announce: "11 of 11" beside an
  // unfiltered chart is a control wearing the clothes of a warning.
  assert.equal(typeFilterWords(11, 11, 217_021, 217_021), null);
});

test("a type chip names the extension, its pack and its size, and survives a missing half", () => {
  assert.equal(typeChipWords(".kt", "kotlin", 63_100), ".kt · kotlin · 63,100");
  // No pack claims it, or the day read no lines: neither prints an empty
  // separator, and neither prints the word null.
  assert.equal(typeChipWords(".mjs", null, 12_228), ".mjs · 12,228");
  assert.equal(typeChipWords(".mjs", "typescript", null), ".mjs · typescript");
});

test("a series too old for the per-type reading says so instead of drawing nothing", () => {
  // The same rule the area panel follows: a chart that is simply absent reads
  // as a chart that failed, and the next action is different for each.
  const s = typesAbsentWords();
  assert.match(s, /measured before the tool counted types/);
  assert.match(s, /re-cut under the current definition/);
  assert.match(s, /nothing above is affected/);
});

test("the per-type caption says it is the same total as the group chart", () => {
  const s = typeStackWords();
  assert.match(s, /the top edge is the whole tree/);
  assert.match(s, /the same total the chart above draws/);
  assert.match(s, /A colour follows a type and not its size/);
});

test("the longest file's readout names the file, and says so when it cannot", () => {
  assert.equal(
    longestPickWords({ day: "2026-09-22", sha7: "683bffa", v: 16351 }, "packages/web/src/App.tsx", true),
    `2026-09-22 \u00b7 ${(16351).toLocaleString()} lines \u00b7 packages/web/src/App.tsx \u00b7 683bffa`,
  );
  assert.match(longestPickWords({ day: "d", v: 1 }, null, true), /no file named that day/);
  assert.doesNotMatch(longestPickWords({ day: "d", v: 1 }, null, false), /named/);
  assert.match(holderWords({ path: "a", readings: 5 }, "x", "y", 5), /every one of the 5 readings/);
  // The method folds (`more`); only what is MISSING is drawn in the open (`lead`).
  const plain = longestCaptionWords({ handovers: 2, folded: 0, unnamed: false, named: true });
  assert.match(plain.more, /changed hands 2 times/);
  assert.equal(plain.lead, null, "nothing missing, nothing in the open");
  const noNames = longestCaptionWords({ handovers: 0, folded: 0, unnamed: false, named: false });
  assert.match(noNames.lead, /cannot be told/, "no names on the wire is an absence, never folded");
  const gaps = longestCaptionWords({ handovers: 1, folded: 0, unnamed: true, named: true });
  assert.match(gaps.lead, /no legend entry/);
  assert.doesNotMatch(gaps.more, /no legend entry/, "said once");
});

test("the rank chip converts like the sentence and never prints a 0th for a missing rank", () => {
  assert.equal(rankChipWords({ rank: 0.38, n: 24 }), "38th percentile of 24");
  assert.equal(rankChipWords({ rank: 1, n: 24 }), "100th percentile of 24");
  assert.equal(rankChipWords({ rank: null, n: 3, reason: "too short" }), null);
  assert.equal(rankChipWords(null), null);
});

test("every tile the sheet draws has a one-line meaning; an unknown key has none", () => {
  for (const k of ["size.p95", "retouch.rate", "hatches.perKloc", "context.claudeMdChars", "context.descChars", "untested.count"]) {
    assert.ok(kpiMeaning(k), k);
  }
  assert.equal(kpiMeaning("dups.pairsPerKloc"), null);
});

// ───────────────────────────────────────────────────────────────────────────
// Whose reading: waterplane's, or the repo's own.
// ───────────────────────────────────────────────────────────────────────────

test("own readings: nothing on the wire says nothing; nothing declared is ONE line naming the file; a declaration is drawn", async () => {
  const { ownShow, ownNoneWords } = await import("./repoHealthWords.ts");
  const file = ".waterplane-shared/health.json";
  assert.deepEqual(ownShow(null), { kind: "none" });
  assert.deepEqual(ownShow({ scope: null }), { kind: "none" }, "an older engine sends no block, and absent is not 'none declared'");
  assert.deepEqual(ownShow({ scope: "apps/x", own: { file, declared: true, series: [] } }), { kind: "none" }, "a scope has no own readings");
  assert.deepEqual(ownShow({ scope: null, own: { file, declared: false, series: [] } }), { kind: "add", file });
  assert.match(ownNoneWords(file), new RegExp(file.replace(/\./g, "\\.")), "the line says WHERE, not just that you could");
  const pending = { file, declared: true, series: [], absent: "declared, not measured yet" };
  assert.equal(ownShow({ scope: null, own: pending }).kind, "drawn", "declared and not yet measured is said, not hidden behind the add line");
  const gone = { file, declared: false, series: [{ key: "k" }] };
  assert.equal(ownShow({ scope: null, own: gone }).kind, "drawn", "a reading with history still draws after the file went");
});

test("provenance words: each group is named once, the repo's aim is the repo's, and no sentence takes a side", async () => {
  const { centralHeadWords, ownHeadWords, ownAimWords, ownApartWords, ownNoneWords } = await import("./repoHealthWords.ts");
  const { indexExplainWords } = await import("./healthIndexWords.ts");
  assert.match(centralHeadWords("waterplane"), /^waterplane's readings/);
  assert.equal(ownHeadWords("acme", ".waterplane-shared/health.json"), "acme's own readings — declared in .waterplane-shared/health.json");
  assert.equal(ownAimWords("higher", "acme"), "acme aims for this to rise.");
  assert.equal(ownAimWords("lower", "acme"), "acme aims for this to fall.");
  assert.equal(ownAimWords(null, "acme"), null, "no declared direction, no sentence — never a guessed one");
  assert.match(ownApartWords("waterplane"), /Not part of the health index, which is built from waterplane's readings only/);
  assert.match(indexExplainWords("2026-06-01", "waterplane"), /waterplane's five readings — never a repo's own/);
  const everything = [centralHeadWords("p"), ownHeadWords("r", "f"), ownAimWords("higher", "r"), ownAimWords("lower", "r"),
    ownApartWords("p"), ownNoneWords("f")].join("\n");
  for (const word of ["score", "grade", "healthy", "unhealthy", "good", "bad", "should", "worse", "better", "improve", "regress"]) {
    assert.doesNotMatch(everything, new RegExp(`\\b${word}\\b`, "i"), `"${word}" is a verdict; a repo's direction is reported as the repo's`);
  }
});

test("a repo's disable or override is said on the tile, attributed, and a disabled tile draws no chart", async () => {
  const { variantWords, variantHidesChart, centralFileLines } = await import("./repoHealthWords.ts");
  const dis = { kind: "disabled", why: "tests live in a separate repo" };
  assert.equal(variantWords(dis).lead, "Disabled here — tests live in a separate repo. Still measured; the health index leaves it out.");
  assert.equal(variantHidesChart(dis), true);
  const ov = {
    kind: "override", why: "generated files dominate", means: "p95 over hand-written files only.", unit: "lines",
    points: [], last: 412, since: "2026-10-16",
  };
  const w = variantWords(ov);
  assert.equal(w.lead, "This repo's own version — p95 over hand-written files only; since 2026-10-16. The index reads 412 lines from it, not the curve below.");
  assert.equal(w.why, "The repo's reason: generated files dominate.");
  assert.equal(w.absent, null);
  assert.equal(variantHidesChart(ov), false);
  assert.equal(variantHidesChart(undefined), false);
  assert.match(variantWords({ ...ov, last: null, since: null, absent: "exit 2" }).lead, /not measured yet\.$/);
  assert.equal(variantWords({ ...ov, absent: "exit 2" }).absent, "On the latest day it printed no number: exit 2.");
  assert.deepEqual(centralFileLines(null), []);
  const lines = centralFileLines({ file: "cfg/health.json", problems: ["`foo` is not one of the five readings"] });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /cfg\/health\.json/);
  assert.equal(lines[1], "Ignored in cfg/health.json: `foo` is not one of the five readings.");
  for (const word of ["score", "grade", "healthy", "good", "bad", "should", "worse", "better"]) {
    assert.doesNotMatch([w.lead, w.why, variantWords(dis).lead, ...lines].join(" "), new RegExp(`\\b${word}\\b`, "i"), word);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// The redesign's region words: the x-axis mode line, the notes row, the path.
// ───────────────────────────────────────────────────────────────────────────

test("the axis line names the mode in its one open sentence and folds the method", () => {
  const w = plotAxisModeWords("weeks", 14, "2026-06-18", "2026-09-21");
  assert.equal(w.lead, "Each tile plots 14 weeks, one point per week — its last day-reading, 2026-06-18 to 2026-09-21, spaced by position in the series, not by date.");
  assert.match(w.more, /NO TILE STARTS AT ZERO/);
  const c = plotAxisModeWords("commits", 1, null, null);
  assert.match(c.lead, /^Each tile plots 1 day-reading, one per day the series has — that day's last commit, spaced/);
  assert.doesNotMatch(w.lead + w.more + c.lead, /[Dd]rag/, "the drag instruction is said once per region, not here");
  assert.match(plotAxisWords(22, "a", "b"), /Drag across a curve/, "the old export still says what it said");
});

test("the notes row counts days", () => {
  assert.equal(notesSummaryWords(12), "daily notes (12 days)");
  assert.equal(notesSummaryWords(1), "daily notes (1 day)");
});

test("a path is shortened in the middle, the filename kept whole", () => {
  const p = "packages/web/src/extensions/chart/day-notes.mjs";
  assert.equal(middleEllipsis(p, 100), p);
  assert.equal(middleEllipsis(p, 24), "packages/…/day-notes.mjs");
  assert.equal(middleEllipsis(p, 30), "packages/…/chart/day-notes.mjs");
  assert.equal(middleEllipsis(p, 16), "…/day-notes.mjs");
  const long = middleEllipsis("a/an-extremely-long-file-name-indeed.ts", 15);
  assert.equal(long.length, 15);
  assert.match(long, /^an-extr….*\.ts$/);
  assert.equal(middleEllipsis("abcdefghij", 5), "ab…ij");
  for (const n of [5, 10, 20, 30, 44]) assert.ok(middleEllipsis(p, n).length <= n, `fits ${n}`);
});

test("a failed run over an unreadable tree is said once: the read error, not the run line too", () => {
  const failed = { ok: false, step: "update", error: "repohealth: not a git repository" };
  assert.equal(outcomeRepeatsReadError(failed, "repohealth: not a git repository", false), true);
  // A series on screen, a refusal, or no read error: the run line is its own news.
  assert.equal(outcomeRepeatsReadError(failed, "x", true), false);
  assert.equal(outcomeRepeatsReadError({ ok: false, refused: { text: "no" } }, "x", false), false);
  assert.equal(outcomeRepeatsReadError(failed, null, false), false);
  assert.equal(outcomeRepeatsReadError({ ok: true, added: 3 }, "x", false), false);
});

test("a pending approval names both of its verbs apart", () => {
  assert.equal(approveRunLabel("repo", { rows: 3 }), "approve and run its engine");
  assert.equal(approveRunLabel("bundled", { rows: 3 }), "approve and update");
  assert.equal(approveRunLabel("bundled", null), "approve and build");
  assert.equal(skipOwnLabel({ rows: 3 }), "update without them");
  assert.equal(skipOwnLabel({ rows: 0 }), "build without them");
});
