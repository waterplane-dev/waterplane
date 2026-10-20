/**
 * What the repo-health tool's output is allowed to be read as.
 *
 * The rule under every case here is the one that is easy to get backwards: a
 * reading that could not be taken is ABSENT, and absent is not zero. A status
 * line missing one field must not become a series claiming 0 days; a run that
 * printed no summary must not become "appended nothing". Both of those read on
 * screen as a measurement, and both would be a lie told with a number.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// Two modules, one subject: `repohealth.js` is the shapes and the words,
// `repohealthread.js` is everything that turns a run's stdout into them. Both
// reach every caller through `@waterplane/shared`; the test names the files because
// it imports the built output directly.
import {
  REPOHEALTH_MD,
  REPOHEALTH_SERIES,
  REPOHEALTH_ENGINE,
  REPOHEALTH_TOOL,
  repoHealthAvailability,
  repoHealthPlotAvailability,
  repoHealthPlotUnavailableText,
  repoHealthUnavailableText,
} from "../dist/repohealth.js";
import { BRAND } from "../dist/brand.js";
import {
  classifyExit,
  parseRepoHealthMeasure,
  parseRepoHealthPlot,
  parseRepoHealthProgress,
  parseRepoHealthStatus,
  parseUpdateSummary,
  recutCommandOf,
} from "../dist/repohealthread.js";
import { isSetupFinding } from "../dist/wire/repo.js";

/** The repo root and the engine inside it, for the one test down at the
 *  bottom that runs the real tool instead of a line shaped like its output. */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const ENGINE = fileURLToPath(new URL("../../../tools/repohealth.mjs", import.meta.url));

const STATUS = {
  preregVersion: "2026-09-21c",
  rows: 158,
  days: 42,
  lastSha: "b875be6f0c1e4a2d9f3b7c5e1a0d8f6b4c2e9a11",
  lastDay: "2026-09-21",
  // SECONDS, because that is what git prints and what the tool passes through.
  lastTs: 1758400000,
  versions: [{ version: "2026-09-21c", rows: 158 }],
  staleRows: 0,
};

test("a full status line is a series, with git's seconds turned into wire milliseconds", () => {
  const s = parseRepoHealthStatus(JSON.stringify(STATUS));
  assert.deepEqual(s, { ...STATUS, lastTs: 1758400000000 });
});

test("a commit instant is milliseconds by the time it leaves here", () => {
  // Read raw, git's seconds land in 1970 and the phone renders a 2026 commit
  // as "690mo ago" — which is exactly what shipped once. Every other instant
  // on this wire is `Date.now()`, so the conversion happens at this boundary
  // and nowhere else.
  const s = parseRepoHealthStatus(JSON.stringify(STATUS));
  const age = 1758400000000 - (s?.lastTs ?? 0);
  assert.equal(age, 0, "lastTs must already be milliseconds");
  assert.ok(new Date(s?.lastTs ?? 0).getUTCFullYear() > 2000, "a plausible year, not 1970");
});

test("the JSON line is found among other output", () => {
  const s = parseRepoHealthStatus(`repohealth: reading .waterplane\n${JSON.stringify(STATUS)}\n`);
  assert.equal(s?.rows, 158);
});

test("two definitions on disk survive the read — that is what refuses the next append", () => {
  const mixed = {
    ...STATUS,
    versions: [
      { version: "2026-09-20", rows: 90 },
      { version: "2026-09-21c", rows: 68 },
    ],
  };
  const s = parseRepoHealthStatus(JSON.stringify(mixed));
  assert.equal(s?.versions.length, 2);
});

test("garbage is null, not an empty series", () => {
  for (const junk of ["", "not json", "{", "null", "[]", "[1,2]", "undefined"]) {
    assert.equal(parseRepoHealthStatus(junk), null, `read something out of ${JSON.stringify(junk)}`);
  }
});

test("one missing field fails the WHOLE object", () => {
  for (const key of Object.keys(STATUS)) {
    const partial = { ...STATUS };
    delete partial[key];
    assert.equal(
      parseRepoHealthStatus(JSON.stringify(partial)),
      null,
      `a status with no ${key} was read as a series`,
    );
  }
});

test("a field of the wrong kind is not repaired", () => {
  const bad = [
    { ...STATUS, rows: "158" },
    { ...STATUS, days: 4.5 },
    { ...STATUS, staleRows: -1 },
    { ...STATUS, lastTs: 0 },
    { ...STATUS, lastSha: "" },
    { ...STATUS, versions: {} },
    { ...STATUS, versions: [{ version: "x" }] },
  ];
  for (const o of bad) assert.equal(parseRepoHealthStatus(JSON.stringify(o)), null);
});

test("backfill progress reads as something to show", () => {
  assert.equal(parseRepoHealthProgress("  …25/158 commits"), "25/158 commits");
  assert.equal(parseRepoHealthProgress("  ...25/158 commits"), "25/158 commits");
});

// ───────────────────────────────────────────────────────────────────────────
// The MEASURE half of the same `status` line — what the ENGINE says about the
// tree, as opposed to what the SERIES says about its own history.
//
// The rule is inverted here and only here: leniently, field by field. These
// arrived after `--root=` did, so a repo carrying its own older copy of the
// tool prints none of them, and a whole-or-nothing reader would take the pack
// list away from every repo one version behind. What must NOT happen is the
// failure this feature already had once: `parseRepoHealthPlot` rebuilds its
// result from the fields it names, so a field nobody named was dropped in
// silence — the tool emitted it, the host relayed it, the phone got
// `undefined`, and nothing anywhere failed. So every field below is asserted
// through the real parse, off a line shaped like the tool's own.
// ───────────────────────────────────────────────────────────────────────────

/** `node tools/repohealth.mjs status` in this repo, 2026-09-21, trimmed to the
 *  additive half. Copied from the tool's output rather than composed. */
const MEASURE = {
  ...STATUS,
  commits: 176,
  engineVersion: "2026-09-21e+c27d320f",
  packs: [
    { name: "common", version: "1", files: 0 },
    { name: "typescript", version: "1", files: 645 },
    { name: "shell", version: "1", files: 6 },
  ],
  groups: [".", "deploy", "packages/app", "packages/host", "packages/shared", "packages/web", "scripts", "tools"],
  recut: "rm /Users/j/dev/myapp/.myapp/repohealth.jsonl && node /Users/j/dev/myapp/tools/repohealth.mjs update --root=/Users/j/dev/myapp",
};

test("every field the engine states about a tree makes the trip", () => {
  const m = parseRepoHealthMeasure(JSON.stringify(MEASURE));
  // Named one by one, deliberately: a `deepEqual` against an object built from
  // the same five keys would pass against a parser that dropped a sixth.
  assert.equal(m?.commits, 176, "the size of the job before any row exists");
  assert.equal(m?.engineVersion, "2026-09-21e+c27d320f");
  assert.equal(m?.recut, MEASURE.recut);
  assert.deepEqual(m?.groups, MEASURE.groups);
  assert.deepEqual(m?.packs, MEASURE.packs);
  // And nothing else came back, so a field added to the tool and not to this
  // parser is a failing test rather than an `undefined` on a phone.
  assert.deepEqual(Object.keys(m ?? {}).sort(), ["commits", "engineVersion", "groups", "packs", "recut"]);
});

test("`commits` is the denominator a repo with no rows is read against", () => {
  // 0 rows against 1,329 commits is "a long walk ahead"; 0 rows against no
  // number at all is "nothing here". Opposite sentences, same series.
  const m = parseRepoHealthMeasure(JSON.stringify({ ...MEASURE, commits: 1329 }));
  assert.equal(m?.commits, 1329);
  assert.equal(parseRepoHealthMeasure(JSON.stringify({ ...MEASURE, commits: -1 }))?.commits, null);
  assert.equal(parseRepoHealthMeasure(JSON.stringify({ ...MEASURE, commits: "1329" }))?.commits, null);
});

test("an engine that says none of it is null — never five empty answers", () => {
  // A repo carrying its own older copy of the tool. `null` is "it did not
  // say"; an object of nulls, or an empty pack list, would read on screen as
  // "this engine could read nothing here", which is a measurement and a wrong
  // one.
  assert.equal(parseRepoHealthMeasure(JSON.stringify(STATUS)), null);
  assert.equal(parseRepoHealthMeasure("not json at all"), null);
  assert.equal(parseRepoHealthMeasure(""), null);
});

test("one bad field is dropped, and the other four still arrive", () => {
  // The opposite of `parseRepoHealthStatus`, on purpose: refusing the object
  // over a missing `recut` would blank the packs for no gain, because none of
  // these is a point on a plot.
  const m = parseRepoHealthMeasure(JSON.stringify({ ...MEASURE, recut: 42, engineVersion: null }));
  assert.equal(m?.recut, null);
  assert.equal(m?.engineVersion, null);
  assert.equal(m?.commits, 176, "…and the fields that were fine are untouched");
  assert.equal(m?.packs?.length, 3);
});

test("a pack that cannot name itself is dropped; one that cannot count is not", () => {
  const m = parseRepoHealthMeasure(JSON.stringify({
    ...MEASURE,
    packs: [{ version: "1", files: 3 }, { name: "kotlin", version: "1" }, { name: "dart", version: "1", files: 12 }],
  }));
  assert.deepEqual(m?.packs, [
    // No count is not a count of zero: a pack still names a language it could
    // read, and 0 files would read as "activated on nothing".
    { name: "kotlin", version: "1", files: null },
    { name: "dart", version: "1", files: 12 },
  ]);
});

test("the re-cut line is carried, never composed — and absent when nobody said it", () => {
  // It ends in `rm`. A client that built it out of a series path and a tool
  // path would be right in the engine's own repo and wrong in every other
  // tree it measures, which is the one place being wrong is unrecoverable.
  assert.equal(recutCommandOf(parseRepoHealthMeasure(JSON.stringify(MEASURE))), MEASURE.recut);
  assert.equal(recutCommandOf(parseRepoHealthMeasure(JSON.stringify(STATUS))), null);
  assert.equal(recutCommandOf(null), null);
  assert.equal(recutCommandOf(undefined), null);
});

test("the series and the engine are read off ONE line and do not disturb each other", () => {
  // Both parsers scan the same stdout. A repo with a full measure must still
  // yield the series it always did, field for field.
  const line = JSON.stringify(MEASURE);
  assert.deepEqual(parseRepoHealthStatus(line), { ...STATUS, lastTs: STATUS.lastTs * 1000 });
  assert.equal(parseRepoHealthMeasure(line)?.commits, 176);
});

test("a warm run prints nothing, and nothing is not progress", () => {
  for (const line of ["", "repohealth: nothing new — 158 rows.", "…25 commits", "25/158"]) {
    assert.equal(parseRepoHealthProgress(line), null);
  }
});

test("the update summary says how many rows it appended", () => {
  assert.deepEqual(
    parseUpdateSummary("repohealth: +3 rows (158 total, 42 days), through b875be6 (2026-09-21), 91 blobs read, 4.2s, 0 stale rows ignored."),
    { added: 3 },
  );
});

test("nothing new is ZERO — a measurement, not an absence", () => {
  assert.deepEqual(
    parseUpdateSummary("repohealth: nothing new — 158 rows, through b875be6 (2026-09-21), 0 stale rows ignored."),
    { added: 0 },
  );
});

test("an unreadable summary is null, never 0", () => {
  assert.deepEqual(parseUpdateSummary("repohealth: wrote tools/repohealth/fixture.json — 42 per-day rows."), { added: null });
  assert.deepEqual(parseUpdateSummary(""), { added: null });
});

test("exit 3 is a refusal carrying its stderr verbatim", () => {
  const stderr =
    "repohealth: refusing to append — the series was measured under a different definition.\n" +
    "  2026-09-20: 90 rows\n" +
    "  2026-09-21c (current): 68 rows\n" +
    "To re-cut the whole history under the current definition:\n" +
    "  rm .waterplane/repohealth.jsonl && node tools/repohealth.mjs update\n";
  const v = classifyExit(3, stderr);
  assert.equal(v.error, null);
  assert.equal(v.refused?.code, 3);
  // Verbatim, to the byte: the remedy deletes a file, and a reader retyping it
  // from a summary is a reader typing it wrong.
  assert.equal(v.refused?.text, stderr);
});

test("exit 1 is an error, one sentence, and never a refusal", () => {
  const v = classifyExit(1, "repohealth: ENOENT: no such file or directory, open '.waterplane/x'\n  at Object…\n");
  assert.equal(v.refused, null);
  // The SUBJECT is the engine, not a path: on a repo read by the desktop's
  // bundled engine there is no `tools/repohealth.mjs` in the tree the reader
  // is standing in, and naming one sends them looking for a file that was
  // never there.
  assert.match(v.error ?? "", new RegExp(`^${REPOHEALTH_ENGINE} exited 1: repohealth: ENOENT`));
  assert.doesNotMatch(v.error ?? "", /tools\/repohealth\.mjs/);
  assert.equal(v.error?.includes("\n"), false);
});

test("a node crash dump is named by its error line, not the source location above it", () => {
  const stderr = [
    "node:internal/modules/esm/resolve:271",
    "    throw new ERR_MODULE_NOT_FOUND(",
    "          ^",
    "",
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/x/packages/shared/dist/index.js' imported from /x/tools/repohealth/statefile.mjs",
    "    at finalizeResolution (node:internal/modules/esm/resolve:271:11)",
    "",
  ].join("\n");
  const v = classifyExit(1, stderr);
  assert.match(v.error ?? "", /exited 1: Error \[ERR_MODULE_NOT_FOUND\]: Cannot find module/);
  assert.doesNotMatch(v.error ?? "", /resolve:271/);
});

test("exit 0 is neither", () => {
  assert.deepEqual(classifyExit(0, "whatever"), { refused: null, error: null });
});

test("exit 2 is the judge's and cannot be reached from here — an error that says so", () => {
  const v = classifyExit(2, 'unknown command "stauts"\n');
  assert.equal(v.refused, null);
  assert.match(v.error ?? "", /judge/);
});

test("a run that never exited is an error, not a silent ok", () => {
  const v = classifyExit(null, "");
  assert.equal(v.refused, null);
  assert.match(v.error ?? "", /never exited/);
});

test("an absent hasRepoHealth is an OLD HOST, never a missing tool", () => {
  assert.equal(repoHealthAvailability({}), "unknown");
  assert.equal(repoHealthAvailability(undefined), "unknown");
  assert.equal(repoHealthAvailability({ hasRepoHealth: true }), "offered");
  assert.equal(repoHealthAvailability({ hasRepoHealth: false }), "absent");
  // And the two silent states each say why, rather than greying a button.
  assert.match(repoHealthUnavailableText("unknown"), /desktop is older/);
  assert.equal(repoHealthUnavailableText("offered"), null);
});

test("`absent` blames the DESKTOP, because the repo is no longer the reason", () => {
  // It used to read "No tools/repohealth.mjs in this repo", which sent the
  // reader to copy 10k lines into their repo. One engine reads every tree
  // now, so the only way to have no reading is for the desktop to be holding
  // no engine — and the sentence has to point there or it aims at the one
  // thing that will not help.
  const s = repoHealthUnavailableText("absent");
  assert.match(s, /desktop/i, "the fix is beside the daemon");
  assert.doesNotMatch(s, /in this repo/i, "…and never a file the reader is told to add to their repo");
  // It still names the path, because that is WHAT is missing on the desktop.
  assert.match(s, new RegExp(REPOHEALTH_TOOL.replace(/\//g, "\\/")));
});

// ───────────────────────────────────────────────────────────────────────────
// The plot. The tool states, the phone draws — and a plot is read WHOLE.
//
// A partial plot is worse than no plot: drawn beside real tiles it is a wrong
// number wearing a chart, and nothing on the screen says which line was the
// invented one. So every case below is the same assertion — one bad field and
// the answer is null.
// ───────────────────────────────────────────────────────────────────────────

const POINT = (day, v) => ({ day, sha7: "abc1234", v });

const PLOT = {
  preregVersion: "2026-09-21c",
  windowReadings: 60,
  minReadings: 14,
  days: 3,
  series: [
    {
      key: "size.p95",
      label: "p95 file length",
      unit: "lines",
      points: [POINT("2026-09-19", 1300), POINT("2026-09-20", null), POINT("2026-09-21", 1352)],
      last: 1352,
      reading: { rank: 0.8864, slope: "rising", n: 2, from: "2026-09-19" },
      detail: "",
    },
    {
      key: "untested.count",
      label: "the count of modules no test names",
      unit: "",
      points: [POINT("2026-09-19", 170), POINT("2026-09-20", 174), POINT("2026-09-21", 176)],
      last: 176,
      reading: { rank: null, slope: null, n: 3, from: "2026-09-19", reason: "not enough history (3 of 14 readings)" },
      detail: "176 of 325 modules in the tree.",
    },
  ],
  context: { areas: { host: { expected: 52174, ceiling: 109583, p90: 76401, commits: 54, subs: 6 } } },
  classics: {
    loc: [POINT("2026-09-19", 141000), POINT("2026-09-20", 142000), POINT("2026-09-21", 143176)],
    files: [POINT("2026-09-19", 320), POINT("2026-09-20", 322), POINT("2026-09-21", 325)],
    deps: [POINT("2026-09-19", 13), POINT("2026-09-20", 13), POINT("2026-09-21", 13)],
    packages: [{ pkg: "web", points: [POINT("2026-09-19", 74000), POINT("2026-09-20", null), POINT("2026-09-21", 75399)] }],
    tape: [16236, 5375, 3074],
  },
};

const plotWith = (patch) => parseRepoHealthPlot(JSON.stringify({ ...PLOT, ...patch }));

test("a whole plot line reads as a plot, and a null day stays null", () => {
  const p = parseRepoHealthPlot(JSON.stringify(PLOT));
  assert.equal(p?.days, 3);
  // The window and the minimum ride on the wire so nothing on the drawing end
  // ever writes 60 and 14 down — a second copy of a pre-registered constant.
  assert.equal(p?.windowReadings, 60);
  assert.equal(p?.minReadings, 14);
  assert.equal(p?.series[0].points[1].v, null, "a day with no reading is null — the line is cut, not floored");
  assert.equal(p?.series[1].reading.rank, null);
  assert.match(p?.series[1].reading.reason ?? "", /not enough history/);
  assert.equal(p?.classics.tape?.length, 3);
});

test("the longest file is optional, and a broken one is dropped not fatal", () => {
  // Absent: a worktree whose tool predates the field. Every chart must still
  // draw — a strict reader here would blank the whole sheet on a desktop one
  // version behind, which is the failure `hasRepoHealth` already exists for
  // one level up.
  assert.equal(parseRepoHealthPlot(JSON.stringify(PLOT))?.longest, undefined);

  const pts = [{ day: "2026-09-19", sha7: "aaaaaaa", v: 16236 }];
  const ok = plotWith({ longest: { points: pts, path: "packages/web/src/App.tsx", day: "2026-09-19" } });
  assert.equal(ok?.longest?.path, "packages/web/src/App.tsx");
  assert.equal(ok?.longest?.points[0].v, 16236);

  // Present and malformed: dropped, and the plot still reads. The name is the
  // half that can mislead, so a missing one is null rather than a guess — and
  // unreadable POINTS take the whole field with them, because a column drawn
  // from half a series is a column a reader would take for a reading.
  assert.equal(plotWith({ longest: { points: pts, path: 42, day: null } })?.longest?.path, null);
  const bad = plotWith({ longest: { points: [{ day: "x", sha7: "y" }] } });
  assert.equal(bad?.longest, undefined);
  assert.equal(bad?.days, 3, "a bad longest is not a bad plot");

  // The per-reading names ride index for index or not at all: one short would
  // pin every name after the gap on its neighbour's day.
  const two = [...pts, { day: "2026-09-20", sha7: "bbbbbbb", v: 16300 }];
  const named = plotWith({ longest: { points: two, path: "b.ts", day: "2026-09-20", paths: ["a.ts", 7] } });
  assert.deepEqual(named?.longest?.paths, ["a.ts", null]);
  const short = plotWith({ longest: { points: two, path: "b.ts", day: "2026-09-20", paths: ["a.ts"] } });
  assert.equal(short?.longest?.paths, undefined);
  assert.equal(short?.longest?.path, "b.ts", "a ragged list costs the list, not the field");
});

test("the JSON line is found among other output, here too", () => {
  const p = parseRepoHealthPlot(`repohealth: 1 row ignored\n${JSON.stringify(PLOT)}\n`);
  assert.equal(p?.series.length, 2);
});

test("a group's rank survives the parse, because this reader drops what it does not name", () => {
  // The bug this assertion exists for had already happened once on this wire:
  // the tool emitted the field, the host relayed the line, and the phone got
  // `undefined` — because the parse rebuilds its result field by field and
  // nobody had named this one. Live proof on 2026-09-21: `node
  // tools/repohealth.mjs plot` printed ranks 0..7 for the eight groups and
  // `GET /api/repos/:id/repohealth` carried `"rank": null` for every one of
  // them. So the assertion goes through the real parse, not past it.
  const packages = [
    { pkg: "packages/host", rank: 1, points: [POINT("2026-09-21", 47084)] },
    { pkg: "packages/web", rank: 0, points: [POINT("2026-09-21", 80062)] },
  ];
  const p = plotWith({ classics: { ...PLOT.classics, packages } });
  assert.deepEqual(p?.classics.packages.map((x) => [x.pkg, x.rank]),
    [["packages/host", 1], ["packages/web", 0]],
    "every group keeps the tool's statement of which are the big ones");

  // Absent is the degrade, and it is a real one: a worktree carrying an engine
  // that predates the field sends no rank, and the drawing end then folds by
  // position exactly as it did before. Never 0 — that is the claim "this is
  // the largest group", which would keep the smallest band on screen.
  const old = parseRepoHealthPlot(JSON.stringify(PLOT));
  assert.equal(old?.classics.packages[0].rank, undefined);
  assert.equal(old?.classics.packages[0].pkg, "web", "and the group itself still arrives");

  // Present and not a count: dropped, not fatal. A fold nobody stated is a
  // question about which hue a band wears, and blanking every chart over it
  // would be the strict reader doing more damage than the missing field.
  const bad = plotWith({
    classics: { ...PLOT.classics, packages: [{ pkg: "web", rank: -1, points: [POINT("2026-09-21", 1)] }] },
  });
  assert.equal(bad?.classics.packages[0].rank, undefined);
  assert.equal(bad?.days, 3, "a bad rank is not a bad plot");
});

test("why there are no areas survives the parse, and so does one area's own reason", () => {
  // The third and fourth fields this reader dropped in exactly the same way,
  // found together. `context` was rebuilt out of `areas` and `absent`, so
  // every repo without the router convention — trading, personal-podcast-news,
  // picture-app, FeedbackPlatform — reached the phone as `areas: {}` with no
  // sentence anywhere, and the panel drew nothing at all. And an area whose
  // router names no source group arrived with the same five nulls as an area
  // nobody has committed to, so the phone printed the wrong one of two
  // opposite sentences about it.
  const p = plotWith({
    context: {
      areas: {},
      areasAbsent: "no skill in this tree routes to another (no `<router>-*` convention)",
    },
  });
  assert.equal(p?.context.areasAbsent, "no skill in this tree routes to another (no `<router>-*` convention)");
  assert.deepEqual(p?.context.areas, {});

  const reason = "the host description names no source group, so no commit can be attributed to it";
  const one = plotWith({
    context: {
      areas: { "host": { expected: null, ceiling: 122288, p90: null, commits: null, subs: 7, reason } },
    },
  });
  assert.equal(one?.context.areas["host"].reason, reason);
  // The numbers beside it are untouched — `ceiling` is a real reading of the
  // tree even where nothing can be attributed, and the nulls stay null.
  assert.equal(one?.context.areas["host"].ceiling, 122288);
  assert.equal(one?.context.areas["host"].expected, null);

  // Absent is the degrade, for both: an engine that predates the fields says
  // nothing and the panel falls back to what it can see.
  const old = parseRepoHealthPlot(JSON.stringify(PLOT));
  assert.equal(old?.context.areasAbsent, undefined);
  assert.equal(old?.context.areas.host.reason, undefined);

  // Present and not a string: the same rule the rest of `context` follows —
  // a sentence is the product here, and half of one is not printable.
  assert.equal(plotWith({ context: { areas: {}, areasAbsent: 42 } }), null);
  assert.equal(
    plotWith({ context: { areas: { host: { ...PLOT.context.areas.host, reason: 7 } } } }),
    null,
  );
});

test("a rank off the [0,1] scale voids the WHOLE plot", () => {
  // Two scales for a percentile once shipped every reading in production as
  // `0th`. Arriving from a host that still has it, the answer is no plot.
  for (const rank of [1.4, -0.2, 86]) {
    const series = [{ ...PLOT.series[0], reading: { ...PLOT.series[0].reading, rank } }, PLOT.series[1]];
    assert.equal(plotWith({ series }), null, `a rank of ${rank} was drawn`);
  }
});

test("a slope that is not one of the three signs voids the whole plot", () => {
  for (const slope of ["up", "RISING", 1, "steep"]) {
    const series = [{ ...PLOT.series[0], reading: { ...PLOT.series[0].reading, slope } }, PLOT.series[1]];
    assert.equal(plotWith({ series }), null, `a slope of ${JSON.stringify(slope)} was drawn`);
  }
});

test("a point with no day voids the whole plot", () => {
  const series = [
    { ...PLOT.series[0], points: [{ sha7: "abc1234", v: 1300 }, ...PLOT.series[0].points.slice(1)] },
    PLOT.series[1],
  ];
  assert.equal(plotWith({ series }), null, "a point that cannot be placed on an axis was drawn anyway");
  // And the same inside classics, which is the same kind of series.
  assert.equal(
    plotWith({ classics: { ...PLOT.classics, loc: [{ day: "", sha7: "abc1234", v: 1 }] } }),
    null,
  );
});

test("a missing windowReadings voids the whole plot — it is never filled in with 60", () => {
  const partial = { ...PLOT };
  delete partial.windowReadings;
  assert.equal(parseRepoHealthPlot(JSON.stringify(partial)), null);
});

test("one missing top-level field fails the whole object", () => {
  for (const key of Object.keys(PLOT)) {
    const partial = { ...PLOT };
    delete partial[key];
    assert.equal(parseRepoHealthPlot(JSON.stringify(partial)), null, `a plot with no ${key} was drawn`);
  }
});

test("garbage is null, not an empty plot", () => {
  for (const junk of ["", "not json", "{", "null", "[]", "[1,2]"]) {
    assert.equal(parseRepoHealthPlot(junk), null, `read something out of ${JSON.stringify(junk)}`);
  }
  // A value that is neither a number nor an explicit null is not a reading,
  // and a tape of anything but line counts is not a tape.
  assert.equal(plotWith({ classics: { ...PLOT.classics, tape: [16236, "5375"] } }), null);
  assert.equal(
    plotWith({ context: { areas: { host: { expected: "52174", ceiling: 1, p90: 1, commits: 1, subs: 1 } } } }),
    null,
  );
});

test("an absent plot is an OLD HOST, a null one is a tool that said nothing", () => {
  assert.equal(repoHealthPlotAvailability({}), "unknown");
  assert.equal(repoHealthPlotAvailability(undefined), "unknown");
  assert.equal(repoHealthPlotAvailability({ plot: null }), "none");
  assert.equal(repoHealthPlotAvailability({ plot: parseRepoHealthPlot(JSON.stringify(PLOT)) }), "plotted");
  // Both silent states say why rather than leaving a blank panel.
  assert.match(repoHealthPlotUnavailableText("unknown"), /older/);
  assert.match(repoHealthPlotUnavailableText("none"), /no series/);
  assert.equal(repoHealthPlotUnavailableText("plotted"), null);
});

test("an engine with no `plot` subcommand is not told to refresh", () => {
  // The standing sentence ends in a remedy, and there is one state where the
  // remedy is the one thing that cannot work: a worktree carrying its own
  // copy of the tool is spawned WITH that copy and WITHOUT `--root=`, so a
  // copy older than `plot` exits 2 on every tap for ever. The host words that
  // case and it REPLACES the remedy rather than joining it — two sentences,
  // one of them pointing at a button that does nothing, is worse than one.
  const why = "The engine that read this repo has no `plot` subcommand — it exited 2 on it.";
  assert.equal(repoHealthPlotUnavailableText("none", why), why);
  assert.doesNotMatch(repoHealthPlotUnavailableText("none", why), /refresh it to measure one/);
  // Absent, null and empty are all "nobody said", which is the ordinary case.
  for (const none of [undefined, null, ""]) {
    assert.match(repoHealthPlotUnavailableText("none", none), /refresh it to measure one/);
  }
  // It only explains a `none`. A drawable plot has nothing to explain, and an
  // old desktop's silence is not the engine's sentence to answer for.
  assert.equal(repoHealthPlotUnavailableText("plotted", why), null);
  assert.match(repoHealthPlotUnavailableText("unknown", why), /older/);
});

// ───────────────────────────────────────────────────────────────────────────
// One predicate, two readers.
// ───────────────────────────────────────────────────────────────────────────

test("a finding is repo scope and not passing — the badge's number and the sheet's cut", () => {
  const checks = [
    { id: "a", label: "a", status: "pass", detail: "", fix: null },
    { id: "b", label: "b", status: "warn", detail: "", fix: "b" },
    { id: "c", label: "c", status: "fail", detail: "", fix: null },
    { id: "gemini", label: "host key", status: "warn", detail: "", fix: null, scope: "host" },
    { id: "gemini-ok", label: "host key", status: "pass", detail: "", fix: null, scope: "host" },
  ];
  assert.deepEqual(checks.filter(isSetupFinding).map((c) => c.id), ["b", "c"]);
  // This IS `summarize()`'s rule, spelled once: repo scope, not passing. A
  // badge counting 3 beside a sheet listing 4 is the bug it prevents, and a
  // host-scope row would flag every repo on the machine at once.
  const summarizeIssues = checks.filter((c) => c.scope !== "host").filter((c) => c.status !== "pass");
  assert.deepEqual(checks.filter(isSetupFinding), summarizeIssues);
  assert.equal(checks.filter(isSetupFinding).length, summarizeIssues.length);
});

test("the paths both ends must agree on", () => {
  assert.equal(REPOHEALTH_MD, ".claude/outbox/repohealth.md");
  assert.equal(REPOHEALTH_SERIES, `${BRAND.stateDirName}/repohealth.jsonl`);
});

// ───────────────────────────────────────────────────────────────────────────
// THE FIELD THE PARSER DOES NOT CARRY.
//
// Everything above pins a field somebody remembered to pin. This pins the
// SHAPE of the mistake instead, because it has now been made three times on
// one wire and every time it was found by a person reading the code rather
// than by anything failing:
//
//   `longest`          — emitted, relayed, `undefined` on the phone.
//   `rank`             — emitted for eight groups, `null` for all eight.
//   `areasAbsent` and  — emitted for every repo without the router
//   an area's `reason`   convention, and the panel drew nothing at all.
//
// One cause each time: `parseRepoHealthPlot` rebuilds its result out of the
// fields it names, so a field nobody named vanishes with no error anywhere. A
// reviewer noticing is not a mechanism. This is:
//
//   run the REAL engine, walk every key path in the document it emits, and
//   assert the parsed object still carries each one.
//
// Read-only and deterministic: `plot --fixture` shapes the committed fixture,
// which is this repo's own mechanism for making a definition change loud, so
// this needs no `.waterplane/` on disk and no git. Two more documents come from the
// engine's own `buildPlot` over rows crafted to force the absence branches —
// the ONLY branches this repo's history can never produce, because this repo
// has the router convention that the missing sentences are about.
//
// Adding a field to the tool therefore turns this red until it is named in
// the parser. Dropping one on purpose is allowed and costs a line in `DROPPED`
// saying why.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Every key path in a JSON document, arrays collapsed to `[]`.
 *
 * `series[].reading.rank`, not `series[0].reading.rank`: the question is which
 * FIELDS made the trip, and an index is not a field. Map-like objects
 * (`context.areas`) come through with their data keys, which is right — the
 * parse rebuilds that map too, and an area lost in it is the same bug.
 */
function keyPaths(v, prefix = "", out = new Set()) {
  if (Array.isArray(v)) {
    for (const e of v) keyPaths(e, `${prefix}[]`, out);
    return out;
  }
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.add(p);
      keyPaths(val, p, out);
    }
  }
  return out;
}

/**
 * Fields the tool emits that the wire deliberately does not carry.
 *
 * Empty today, and that is the point: every field the engine states about a
 * plot reaches the phone. An entry here is a decision — the key, and the
 * sentence saying why the drawing end is better off without it.
 */
const DROPPED = new Map([
  // ["classics.tape[]", "a distribution of today, replaced by … — example only"],
]);

function assertCarried(label, stdout) {
  const emitted = lastJsonLine(stdout);
  assert.ok(emitted, `${label}: the engine printed no JSON object to read.\n${stdout.slice(0, 400)}`);
  const parsed = parseRepoHealthPlot(stdout);
  assert.ok(parsed, `${label}: the real engine's own output did not survive parseRepoHealthPlot.`);
  const want = [...keyPaths(emitted)].filter((p) => !DROPPED.has(p)).sort();
  const have = keyPaths(parsed);
  const lost = want.filter((p) => !have.has(p));
  assert.deepEqual(
    lost, [],
    `${label}: the engine emits these key paths and parseRepoHealthPlot does not carry them.\n` +
    `That reader rebuilds its result from the fields it NAMES, so an unnamed field is dropped\n` +
    `in silence — the tool emits it, the host relays it, the phone reads undefined, and nothing\n` +
    `else fails. Name each one in parseRepoHealthPlot and give it a type in repohealth.ts, or\n` +
    `add it to DROPPED with the sentence saying why the phone is better off without it.`,
  );
  return want;
}

/** The last line that parses as an object — the same rule the parser uses, so
 *  a warning printed before the document is not mistaken for it. */
function lastJsonLine(stdout) {
  let last = null;
  for (const line of String(stdout).split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object" && !Array.isArray(v)) last = v;
    } catch { /* not the line */ }
  }
  return last;
}

test("every key path the real engine emits survives parseRepoHealthPlot", () => {
  // `--fixture` is the committed 22 day-rows, so this is the engine's own
  // shaping code over input that is in git: no `.waterplane/` on disk, no git
  // history read, nothing written, and the same document on every machine.
  const stdout = execFileSync(process.execPath, [ENGINE, "plot", "--fixture"], {
    cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const want = assertCarried("plot --fixture", stdout);
  // A guard on the guard: if the fixture ever shapes down to a stub, the
  // comparison above passes against nothing. These are the fields the bug has
  // already been made on.
  for (const key of ["series[].reading.rank", "classics.packages[].rank", "longest.path"]) {
    assert.ok(want.includes(key), `the fixture document no longer carries ${key} — this check went vacuous`);
  }
});

test("…including the absence sentences this repo's own history can never produce", async () => {
  // myapp HAS the router convention, so no plot of it ever carries the two
  // fields that were dropped. The engine's own `buildPlot` is called directly
  // on rows shaped to force each branch — one level BELOW the parser, so it is
  // still the tool deciding what a plot says, and a metric that renames its
  // field fails the assertion under each case rather than passing vacuously.
  const { buildPlot } = await import(new URL("../../../tools/repohealth/plot.mjs", import.meta.url));
  const { PREREG, PREREG_VERSION } = await import(new URL("../../../tools/repohealth/constants.mjs", import.meta.url));
  const row = (context) => ({
    sha: "c".repeat(40), day: "2026-09-21", ts: 1790019502, prereg: PREREG_VERSION, context: { value: context },
  });
  const docOf = (context) =>
    JSON.stringify(buildPlot({ rows: [row(context)], prereg: PREREG, preregVersion: PREREG_VERSION }));

  // A tree with no `<router>-*` convention: read, and no per-area rows in it.
  const none = docOf({
    claudeMdChars: 12000, descChars: 3000, skillCount: 4, areas: {},
    areasReason: "no skill in this tree routes to another (no `<router>-*` convention)",
  });
  assert.ok(
    assertCarried("no router convention", none).includes("context.areasAbsent"),
    "the metric no longer states why `areas` is empty — find where that sentence went",
  );

  // An area whose router description names no source group: a real ceiling,
  // three permanent nulls, and the only thing that tells them from an area
  // nobody has committed to.
  const unattributable = docOf({
    claudeMdChars: 12000, descChars: 3000, skillCount: 4,
    areas: {
      "host": {
        ceiling: 122288, commits: null, expected: null, p90: null, subs: 7,
        reason: "the host description names no source group, so no commit can be attributed to it",
      },
    },
  });
  assert.ok(
    assertCarried("an area with no source group", unattributable).includes("context.areas.host.reason"),
    "the metric no longer states an area's own reason — find where that sentence went",
  );

  // A tree with no `.claude/skills`: the context family IS read — CLAUDE.md
  // has a size — and two of its series have no value. myapp can never produce
  // this either, because myapp has skills. The sentence is the metric's own
  // `skillsReason`, and it reaches the phone on the SERIES, which is the only
  // place a reader is looking when they wonder why that tile is empty.
  const noSkills = docOf({
    claudeMdChars: 7448, descChars: null, skillCount: null,
    skillsReason: "no .claude/skills at this commit",
    areas: {}, areasReason: "no skill in this tree routes to another (no `<router>-*` convention)",
  });
  assert.ok(assertCarried("a tree with no skills", noSkills).includes("series[].absent"));
  const parsed = parseRepoHealthPlot(noSkills);
  for (const key of ["context.descChars", "context.skillCount"]) {
    assert.equal(
      parsed.series.find((s) => s.key === key)?.absent,
      "no .claude/skills at this commit",
      `${key} arrived with no reason. A null is a cut and an absence carries a sentence — this is ` +
      "the one series-level null that had neither, and the phone printed its own guess instead.",
    );
  }
});

// ───────────────────────────────────────────────────────────────────────────
// A repo's OWN readings: carried apart from waterplane's, with their provenance.
// ───────────────────────────────────────────────────────────────────────────

test("own readings survive the parse as the repo's, apart from waterplane's — every key path included", async () => {
  const { buildPlot } = await import(new URL("../../../tools/repohealth/plot.mjs", import.meta.url));
  const { PREREG, PREREG_VERSION } = await import(new URL("../../../tools/repohealth/constants.mjs", import.meta.url));
  const own = (value, reason) => ({
    file: ".waterplane-shared/health.json",
    readings: [{ key: "screenFixtures", name: "Signals", means: "How many.", better: "higher", unit: "signals", value, ...(reason ? { reason } : {}) }],
    problems: ["entry 2 has no usable \"key\""],
  });
  const rows = [
    { sha: "a".repeat(40), day: "2026-10-14", ts: 1, prereg: PREREG_VERSION },
    { sha: "b".repeat(40), day: "2026-10-15", ts: 2, prereg: PREREG_VERSION, own: own(4) },
    { sha: "c".repeat(40), day: "2026-10-16", ts: 3, prereg: PREREG_VERSION, own: own(null, "exited 1: version unknown") },
  ];
  const doc = JSON.stringify(buildPlot({ rows, prereg: PREREG, preregVersion: PREREG_VERSION, ownDeclared: true }));
  const want = assertCarried("own readings", doc);
  for (const key of ["own.series[].means", "own.series[].better", "own.series[].source", "own.problems", "series[].source"]) {
    assert.ok(want.includes(key), `the document no longer carries ${key}`);
  }
  const plot = parseRepoHealthPlot(doc);
  assert.ok(plot.series.every((s) => s.source === "central"));
  const [s] = plot.own.series;
  assert.equal(s.source, "repo");
  assert.deepEqual(s.points.map((p) => p.v), [null, 4, null], "before it was declared is a hole, and a failed run is a hole");
  assert.equal(s.last, null);
  assert.equal(s.absent, "exited 1: version unknown");
  assert.equal(plot.own.declared, true);
});

test("an older engine's series read as waterplane's; a malformed own block is dropped WHOLE, never half-drawn", () => {
  const base = {
    preregVersion: "v", windowReadings: 60, minReadings: 14, days: 1,
    series: [{ key: "size.p95", label: "p95", unit: "lines", points: [{ day: "2026-10-16", sha7: "abcdef0", v: 3 }], last: 3, reading: { rank: null, slope: null, n: 1, from: "2026-10-16", reason: "r" }, detail: "" }],
    context: { areas: {} },
    classics: { loc: [], files: [], deps: [], packages: [], tape: null },
  };
  const old = parseRepoHealthPlot(JSON.stringify(base));
  assert.equal(old.series[0].source, "central");
  assert.equal("own" in old, false, "no field from an older engine stays no field — the phone then says nothing about own readings");

  const mislabelled = { ...base, series: [{ ...base.series[0], source: "repo" }] };
  assert.equal(parseRepoHealthPlot(JSON.stringify(mislabelled)), null, "a repo reading inside waterplane's list is a document nobody wrote");

  const ownSeries = { ...base.series[0], key: "x", source: "repo", means: "m", better: "higher" };
  const good = parseRepoHealthPlot(JSON.stringify({ ...base, own: { file: "f", declared: true, series: [ownSeries] } }));
  assert.equal(good.own.series.length, 1);
  const unlabelled = parseRepoHealthPlot(JSON.stringify({ ...base, own: { file: "f", declared: true, series: [{ ...ownSeries, source: undefined }] } }));
  assert.ok(unlabelled, "the rest of the plot still draws");
  assert.equal("own" in unlabelled, false, "provenance is never guessed");
});

test("…and a repo's central disable and override (`variant`, `central`) survive the parse", async () => {
  const { buildPlot } = await import(new URL("../../../tools/repohealth/plot.mjs", import.meta.url));
  const { PREREG, PREREG_VERSION } = await import(new URL("../../../tools/repohealth/constants.mjs", import.meta.url));
  const central = {
    file: ".waterplane-shared/health.json", fp: "abc",
    disabled: { context: { why: "CLAUDE.md is generated" } },
    override: { size: { why: "ours only", means: "p95 of ours", run: ["node", "p.mjs"], value: null, reason: "exited 1" } },
    problems: ['"bogus" is not a central reading'],
  };
  const rows = ["2026-09-21", "2026-09-22"].map((day, i) => ({
    sha: String(i).repeat(40), day, ts: 1790019502 + i * 86400, prereg: PREREG_VERSION,
    size: { value: { p95: 400, max: 900, nearMax: 2 } },
    context: { value: { claudeMdChars: 12000, descChars: 3000, skillCount: 4, skillBodyChars: 9000, areas: {} } },
    ...(i === 1 ? { central } : {}),
  }));
  const doc = JSON.stringify(buildPlot({ rows, prereg: PREREG, preregVersion: PREREG_VERSION }));
  const want = assertCarried("central variants", doc);
  for (const key of ["series[].variant.kind", "series[].variant.why", "series[].variant.points[].v", "series[].variant.since", "series[].variant.absent", "central.problems"]) {
    assert.ok(want.includes(key), `the document no longer carries ${key}`);
  }
  const parsed = parseRepoHealthPlot(doc);
  const size = parsed.series.find((s) => s.key === "size.p95");
  assert.equal(size.variant.kind, "override");
  assert.equal(size.variant.last, null);
  assert.equal(size.variant.absent, "exited 1");
  assert.deepEqual(parsed.series.find((s) => s.key === "context.descChars").variant, { kind: "disabled", why: "CLAUDE.md is generated" });
  // A variant that does not match the plot's days is dropped whole, never half-read.
  const bad = JSON.parse(doc);
  bad.series.find((s) => s.key === "size.p95").variant.points.pop();
  assert.equal(parseRepoHealthPlot(JSON.stringify(bad)).series.find((s) => s.key === "size.p95").variant, undefined);
});
