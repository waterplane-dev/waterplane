/**
 * The repo-health series cannot be allowed to rewrite its own history.
 *
 * ── Why this is a test and not a sentence ───────────────────────────────────
 *
 * Every number this tool reports is read against its own past: a percentile
 * rank within a trailing window and the sign of a slope. That is what makes it
 * readable without thresholds — and it is also what makes it fragile in a way
 * a normal metric is not. Change how a re-touch is counted, or where the batch
 * cutoff falls, or which regex spells an escape hatch, and every past day
 * silently becomes a different number. The plot moves, the narrative speaks,
 * and nothing anywhere says that the code changed rather than the repo.
 *
 * `tools/repohealth/constants.mjs` answers the first half of that by putting
 * every such decision in one frozen block with its justification. This file is
 * the other half: the backfill those constants produced on the day they were
 * chosen is committed as `fixture.json`, and the rows are re-derived here. A
 * definition change therefore cannot land quietly — it lands as a diff in
 * which the past has moved, which is exactly the thing that is hard to see in
 * review and easy to see in a failing assertion.
 *
 * Same argument `tools/claudemd.test.mjs` makes about a budget, and it is the
 * argument this whole tool is built on: a rule that is only prose fails
 * silently, weeks later, in a diff nobody reads as a violation.
 *
 * ── The second thing under guard: the token bill ────────────────────────────
 *
 * This tool is free. Git, regex, and local computation — no model, anywhere on
 * the path that runs by default. Exactly one question is worth a model ("is
 * this duplicate pair really a fork of the same behaviour?"), and it sits
 * behind `judge`, which prints what it would cost and spends nothing without
 * an explicit yes.
 *
 * "We don't call a model here" is true right up until someone adds an import,
 * and an import is invisible in review. So it is asserted as a text check over
 * every module: only `judge.mjs` may name `claude` as a spawn target, only the
 * CLI's `judge` branch may reach `judge.mjs`, and `run()` with no confirmation
 * must leave the spawn count at zero. A guard that is only a convention is not
 * a guard.
 *
 * ── What is deliberately NOT checked ────────────────────────────────────────
 *
 * No absolute value at HEAD. Not "App.tsx is 16,236 lines", not "131 modules
 * are untested", not a re-touch rate. Those drift with every commit and
 * pinning them would make this file fail for the sole reason that somebody
 * wrote some code — which would teach exactly the wrong reflex, that a red
 * test here means "regenerate the fixture".
 *
 * Nor is any reading asserted to be GOOD. Nothing here says a rank should
 * fall, that duplicates should trend to zero, or that the untested list should
 * shrink. The tool reads; it does not grade. A test that encoded a direction
 * would be the threshold the whole design refuses to pick.
 *
 * Nor the wording of sentences, beyond the two structural rules that carry the
 * meaning: a number never travels without the number it is compared with, and
 * no verdict word ever appears.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { PREREG } from "./repohealth/constants.mjs";
import { configure } from "./repohealth/census.mjs";
import { stateFile } from "./repohealth/statefile.mjs";
import common from "./repohealth/packs/common.mjs";
import * as git from "./repohealth/git.mjs";
import { buildSnapshot } from "./repohealth/snapshot.mjs";
import { readRank, perDay, ROW_KEYS } from "./repohealth/series.mjs";
import { measureSize } from "./repohealth/metrics/size.mjs";
import { measureHatches } from "./repohealth/metrics/hatches.mjs";
import { measureContext } from "./repohealth/metrics/context.mjs";
import { measureUntested } from "./repohealth/metrics/untested.mjs";
import { measureClassics, tapeLines, tapePaths } from "./repohealth/metrics/classics.mjs";
import { normalizeScope, scopeHistory, slugFor } from "./repohealth/scope.mjs";
import { measureRetouch } from "./repohealth/metrics/retouch.mjs";
import { measureCochange } from "./repohealth/metrics/cochange.mjs";
import { measureDups } from "./repohealth/metrics/dups.mjs";
import { measureDeadExports } from "./repohealth/metrics/deadexports.mjs";
import { measureTripwires } from "./repohealth/metrics/tripwires.mjs";
import { events, render } from "./repohealth/narrate.mjs";
import { PLAIN_REASON, SERIES, numbersIn, reading } from "./repohealth/readings.mjs";
import { bundle, run } from "./repohealth/judge.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const TOOL_DIR = join(ROOT, "tools", "repohealth");

/**
 * The effective configuration of THIS repo — `PREREG`'s method plus the shape
 * `census.mjs` derives from the tree at HEAD — built once, exactly as the CLI
 * builds it.
 *
 * Every `measure*` takes this and not `PREREG`: half of what they used to
 * read off the frozen block (which extensions are source, what a test file is
 * called, which escape hatches exist, which skills are routers) is now a fact
 * about the repo in front of the engine, and a test that passed the method
 * alone would be exercising a configuration no run ever uses.
 *
 * `CFG.VERSION` is what a row records — `<PREREG_VERSION>+<hash of the active
 * packs>` — so the fixture, the rows and the plot are all compared against it
 * rather than against the engine half alone. A pack bump moves it, which is
 * the point: the series was re-cut.
 */
const CFG = configure(ROOT, git);
/** `retouch` needs the line-level history (`git.readHunks`); read once, lazily. */
let HUNKS_MEMO = null;
const HUNKS = () => (HUNKS_MEMO ??= git.readHunks(ROOT));

/** Every module of the tool, as text, for the checks that are about code shape. */
function toolSources() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".mjs")) out.push({ path: p, text: readFileSync(p, "utf8") });
    }
  };
  walk(TOOL_DIR);
  out.push({ path: join(ROOT, "tools", "repohealth.mjs"), text: readFileSync(join(ROOT, "tools", "repohealth.mjs"), "utf8") });
  return out.filter((f) => !f.path.endsWith("fixture.json"));
}

// ───────────────────────────────────────────────────────────────────────────
// The fixture: the history must still mean what it meant.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Re-reading 22 trees is seconds, and `npm run test:unit` is 90ms of tests
 * today. So the default walks a stride through the fixture and
 * `REPOHEALTH_FULL=1` walks all of it. The stride always includes the last
 * row, because that is the one a change is most likely to move.
 */
function fixtureRowsUnderTest(fixture) {
  const rows = fixture.rows;
  if (process.env.REPOHEALTH_FULL === "1") return rows;
  const stride = [];
  for (let i = 0; i < rows.length; i += 6) stride.push(rows[i]);
  if (stride[stride.length - 1] !== rows[rows.length - 1]) stride.push(rows[rows.length - 1]);
  return stride;
}

/**
 * Two fields of a row cannot be reproduced from one sha, and they are the
 * same fact twice.
 *
 * The other metrics are functions of one tree: hand `measureSize` a snapshot
 * and it returns the same answer forever. A tripwire is a TRANSITION — a file
 * crossing 2,000 lines, a kind of escape hatch used for the first time — so
 * it is a function of everything before it. That chain used to live in a
 * module-level memo, which is empty in a fresh process: a daily `update`
 * computed "nothing crossed anything" and the append-only log recorded that
 * permanently. It now travels on the row as `tripwireState`, so a row can be
 * derived from its predecessor alone.
 *
 * That fixes the bug and does not make a single sha self-sufficient. In the
 * strided pass below, the `prevRow` to hand is the previous DAY-row, not the
 * previous commit, and `hatchSeen` is cumulative over every commit between
 * them — so both fields are checked only under `REPOHEALTH_FULL=1`, which
 * replays all 155 commits in order and is the only form in which a transition
 * series means anything at all.
 */
const CHAINED = new Set(["tripwires", "tripwireState"]);
const REPRODUCIBLE_FROM_ONE_SHA = ROW_KEYS.filter((k) => !CHAINED.has(k));

/** Recompute one row exactly as the CLI does, for a sha the fixture names. */
function recompute(sha, history, prevRow, knownIndex) {
  const snap = buildSnapshot(ROOT, sha, git, CFG);
  const index = knownIndex ?? history.commits.findIndex((c) => c.sha === sha);
  const m = (fn) => fn(snap, history, index, CFG);
  const tw = measureTripwires(snap, history, index, CFG, prevRow);
  const c = history.commits[index];
  return {
    sha,
    day: c.day,
    ts: c.ts,
    batch: c.batch,
    prereg: CFG.VERSION,
    size: m(measureSize),
    retouch: m(measureRetouch),
    hatches: m(measureHatches),
    dups: m(measureDups),
    deadExports: m(measureDeadExports),
    cochange: m(measureCochange),
    context: m(measureContext),
    untested: m(measureUntested),
    classics: m(measureClassics),
    tripwires: Array.isArray(tw) ? tw : (tw?.value ?? []),
    tripwireState: tw?.state ?? null,
  };
}

test("the fixture's own version matches the constants that produced it", (t) => {
  const fixture = JSON.parse(readFileSync(join(TOOL_DIR, "fixture.json"), "utf8"));
  // The pack half is a fact about the tree the fixture was recorded in: a copy
  // that leaves files out (the public snapshot drops private extensions, and
  // with them the one .py file) activates other packs. Where the recorded
  // history is not in this clone, only the method half is comparable.
  try {
    execFileSync("git", ["cat-file", "-e", `${fixture.lastSha}^{commit}`], { cwd: ROOT, stdio: "ignore" });
  } catch {
    t.diagnostic(`fixture's last commit ${String(fixture.lastSha).slice(0, 7)} is not in this clone: comparing PREREG_VERSION only`);
    assert.equal(fixture.prereg.split("+")[0], CFG.VERSION.split("+")[0], "PREREG_VERSION moved without regenerating the fixture");
    return;
  }
  assert.equal(
    fixture.prereg,
    CFG.VERSION,
    "You changed a definition without regenerating the fixture.\n" +
      "That is not a lint failure — it means every past day in the series now\n" +
      "means something different from what it meant when it was recorded.\n" +
      "The version has two halves and either can move it: bump PREREG_VERSION\n" +
      "for a change to the METHOD, or a pack's `version` for a change to what\n" +
      "one language contributes. Then run\n" +
      "`node tools/repohealth.mjs update --fixture` IN THE SAME COMMIT, so the\n" +
      "diff shows the history moving.",
  );
});

test("the recorded history still reproduces", (t) => {
  const fixture = JSON.parse(readFileSync(join(TOOL_DIR, "fixture.json"), "utf8"));
  // A shallow clone has no history to reproduce. Say so and skip — never pass
  // silently (which would hide a real break) and never fail (which would make
  // a legitimate checkout look broken).
  try {
    execFileSync("git", ["cat-file", "-e", `${fixture.rows[0].sha}^{commit}`], { cwd: ROOT, stdio: "ignore" });
  } catch {
    t.skip(`fixture's first commit ${fixture.rows[0].sha.slice(0, 7)} is not in this clone (shallow?)`);
    return;
  }

  const history = { ...git.readHistory(ROOT, CFG), hunks: HUNKS() };
  const full = process.env.REPOHEALTH_FULL === "1";

  if (full) {
    // The whole series, reduced exactly as the CLI reduces it. This is the
    // only form in which tripwires mean anything: they are transitions, so
    // they need every commit walked in order, and `perDay` unions the ones a
    // day fired rather than keeping only its last commit's.
    let prev = null;
    const rows = history.commits.map((c, i) => {
      const row = recompute(c.sha, history, prev, i);
      prev = row;
      return row;
    });
    assert.deepEqual(
      JSON.parse(JSON.stringify(perDay(rows))),
      fixture.rows,
      "the full replay no longer reproduces the recorded history — a definition changed under the series",
    );
    return;
  }

  // The cheap pass: re-derive a stride of day-rows from their own tree alone,
  // and compare the eight fields that a single tree determines.
  const byIndex = new Map(fixture.rows.map((r, i) => [r.sha, i]));
  let checked = 0;
  for (const want of fixtureRowsUnderTest(fixture)) {
    const i = byIndex.get(want.sha);
    const got = JSON.parse(JSON.stringify(recompute(want.sha, history, i > 0 ? fixture.rows[i - 1] : null)));
    for (const k of REPRODUCIBLE_FROM_ONE_SHA) {
      assert.deepEqual(
        got[k],
        want[k],
        `row ${want.day} (${want.sha.slice(0, 7)}) no longer reproduces its \`${k}\` — ` +
          "a definition changed under the series, so every past day now means something\n" +
          "different from what it meant when it was recorded. If that is intended, bump\n" +
          "PREREG_VERSION and regenerate the fixture in the same commit.\n" +
          "(Tripwires and their state are checked only under REPOHEALTH_FULL=1; see the note above.)",
      );
    }
    checked++;
  }
  assert.ok(checked > 0);
});

test("a row carries every key the contract names, in a fixed order", () => {
  const fixture = JSON.parse(readFileSync(join(TOOL_DIR, "fixture.json"), "utf8"));
  for (const row of fixture.rows) assert.deepEqual(Object.keys(row), [...ROW_KEYS]);
});

// ───────────────────────────────────────────────────────────────────────────
// The reading rules, on synthetic inputs. No git, no repo.
// ───────────────────────────────────────────────────────────────────────────

test("a rank is absent rather than zero when there is not enough history", () => {
  const thin = readRank(Array.from({ length: PREREG.RANK_MIN_POINTS - 1 }, (_, i) => i), PREREG);
  assert.equal(thin.rank, null);
  assert.match(thin.reason, /not enough history/);
  const enough = readRank(Array.from({ length: PREREG.RANK_MIN_POINTS }, (_, i) => i), PREREG);
  assert.equal(typeof enough.rank, "number");
  assert.ok(enough.rank > 0 && enough.rank <= 1, "mid-rank never lands on 0 — a rank of 0 and an absence are opposite claims");
});

test("escape hatches are counted as occurrences, word-bounded", () => {
  const text = [
    "// this comment has any number of words, and was any good?",
    "const a: any = 1;",
    "const b = x as any;",
    "const c = y as unknown as Z;",
    'const msg = "TODO: not a real todo marker, but TODO counts as one";',
  ].join("\n");
  const snap = {
    sha: "x",
    files: [{ path: "packages/web/src/a.ts", oid: "o", text, loc: 5 }],
    groups: ["packages/web"],
    skills: [],
    areas: [],
    tests: [],
    manifests: [],
  };
  const got = measureHatches(snap, { commits: [], touches: new Map(), batch: new Set() }, 0, CFG).value;
  assert.equal(got.asAny, 1, '"has any" and "was any" are prose, not escape hatches');
  assert.equal(got.colonAny, 1);
  assert.equal(got.asUnknownAs, 1);
  assert.equal(got.tsIgnore, 0, "a kind at zero is still reported, so the new-kind tripwire has a name to fire on");
});

test("a re-touch rate never travels without its denominator", () => {
  const fixture = JSON.parse(readFileSync(join(TOOL_DIR, "fixture.json"), "utf8"));
  for (const row of fixture.rows) {
    const v = row.retouch.value;
    if (!v) {
      assert.ok(row.retouch.reason, "an absent reading says why");
      continue;
    }
    assert.equal(typeof v.touches, "number");
    assert.equal(typeof v.retouches, "number");
    assert.ok(Math.abs(v.retouches / v.touches - v.rate) < 1e-12, "rate is its own two numbers");
  }
});

test("absence is a reason, never a zero", () => {
  const empty = {
    sha: "x",
    files: [],
    groups: [],
    skills: [],
    areas: [],
    tests: [],
    manifests: [],
    claudeMdChars: null,
    claudeMdLines: null,
    agentsMdLines: null,
  };
  const hist = { commits: [{ sha: "x", ts: 0, day: "2026-01-01", subject: "", filesTouched: [], batch: false }], touches: new Map(), batch: new Set() };
  for (const [name, fn] of [["size", measureSize], ["context", measureContext], ["untested", measureUntested], ["classics", measureClassics]]) {
    const got = fn(empty, hist, 0, CFG);
    assert.equal(got.value, null, `${name} on an empty tree must be absent`);
    assert.ok(got.reason, `${name} must say why it is absent`);
  }
});

test("a tree no language pack reads reports absences, never zeros", () => {
  // The engine runs against every repo on this desktop, and several of them
  // are written in languages no pack claims. The failure this guards is the
  // confident zero: "no duplicate pairs", "no dead exports", "every module
  // untested" — three sentences about files nothing opened. Built with the
  // real `configure` over the real `common` pack, so it is the contract that
  // is under test and not a literal shaped like one.
  const bare = configure(ROOT, git, [common]);
  assert.deepEqual(bare.SRC.exts, [], "a repo no pack claims has no source extensions at all");

  const snap = {
    sha: "x",
    files: [{ path: "app/src/main/kotlin/Main.kt", oid: "o", text: "fun main() {}\n", loc: 1 }],
    groups: ["app"],
    claudeMdChars: 100,
    claudeMdLines: 1,
    agentsMdLines: null,
    skills: [],
    areas: [],
    tests: [{ path: "app/src/test/kotlin/MainTest.kt", text: "" }],
    manifests: [],
  };
  const hist = { commits: [{ sha: "x", ts: 0, day: "2026-01-01", subject: "", filesTouched: [], batch: false }], touches: new Map(), batch: new Set() };
  for (const [name, fn] of [["dups", measureDups], ["deadExports", measureDeadExports], ["untested", measureUntested]]) {
    const got = fn(snap, hist, 0, bare);
    assert.equal(got.value, null, `${name} must not report a number over a tree nothing parsed`);
    assert.ok(got.reason && got.reason.length > 0, `${name} must say why`);
    assert.match(got.reason, /pack/, `${name}: the reason names the packs, which is what a reader can act on`);
  }
  // And the dependency half of `classics`, which reads a manifest the same
  // way: null with a reason, never a row of zeros.
  const classics = measureClassics(snap, hist, 0, bare);
  assert.equal(classics.value.deps, null);
  assert.match(classics.value.depsReason, /pack/);
});

// ───────────────────────────────────────────────────────────────────────────
// The context row: a budget you can satisfy by relocating is not a budget.
// ───────────────────────────────────────────────────────────────────────────

/**
 * A tree with one area, on hand-built literals: no repo, no git, no skills on
 * disk. The point is the aggregator, so everything else is held still.
 *
 * `groups` and `areas` are part of the snapshot now — `snapshot.mjs` derives
 * both from each commit's own tree — so a literal has to carry them. The
 * area's `src` is a group NAME, `packages/web`, and a commit is a task in the
 * area when `groupOf` puts one of its files in that group: the two `groups`
 * entries are what make that lookup two segments deep rather than one.
 */
function areaTree({ claudeMd = 1000, router = 100, subs = [] }) {
  return {
    sha: "x",
    files: [],
    groups: ["packages/host", "packages/web"],
    claudeMdChars: claudeMd,
    claudeMdLines: 1,
    agentsMdLines: null,
    skills: [
      { name: "web", descriptionChars: 0, bodyChars: router, generated: false, headModules: [] },
      ...subs.map((s) => ({
        name: s.name,
        descriptionChars: 0,
        bodyChars: s.body,
        generated: false,
        headModules: [...s.mods].sort(),
      })),
    ],
    areas: [{ router: "web", src: "packages/web", also: [] }],
    tests: [],
    manifests: [],
  };
}

/** One commit per module, each touching that module alone. */
function areaHistory(mods) {
  const commits = mods.map((m, i) => ({
    sha: "c" + i,
    ts: i,
    day: "2026-01-0" + (i + 1),
    subject: m,
    filesTouched: ["packages/web/src/" + m],
    batch: false,
  }));
  return { commits, touches: new Map(commits.map((c) => [c.sha, c.filesTouched])), batch: new Set() };
}

test("splitting a skill moves `expected` and cannot move `ceiling`", () => {
  // The whole reason this row has two numbers. `web` went from a 109k
  // body to a 7.7k router plus seven sub-skills and not one character of the
  // prose was deleted; a metric that read the router, or the biggest body,
  // would have printed that week as a 90% saving. So: same prose, two
  // partitions, and only the routing number is allowed to notice.
  const before = areaTree({ subs: [{ name: "web-a", body: 60, mods: ["A.tsx", "B.tsx"] }, { name: "web-c", body: 40, mods: ["C.tsx"] }] });
  const after = areaTree({ subs: [
    { name: "web-a", body: 30, mods: ["A.tsx"] },
    { name: "web-b", body: 30, mods: ["B.tsx"] },
    { name: "web-c", body: 40, mods: ["C.tsx"] },
  ] });
  const hist = areaHistory(["A.tsx", "B.tsx", "C.tsx"]);
  // Keyed by ROUTER NAME: `web` would have to be cut off `web` by a rule
  // that is this repo's naming convention and nothing else's.
  const at = (snap) => measureContext(snap, hist, hist.commits.length - 1, CFG).value.areas["web"];

  const b = at(before);
  const a = at(after);
  assert.equal(
    a.ceiling,
    b.ceiling,
    "the same prose in more files weighs the same. A ceiling that fell here would be the\n" +
      "relocation discount this row exists to refuse.",
  );
  assert.ok(a.expected < b.expected, "a narrower task loads less — that is what a split buys, and it is `expected` that says so");
  assert.equal(b.expected, 1000 + 100 + 60, "before: two of the three commits pull the 60-char skill");
  assert.equal(a.expected, 1000 + 100 + 30, "after: each commit pulls only its own");
});

test("a module two sub-skills claim costs both, and one nobody claims costs the router", () => {
  // The router says a module on two lines has rules in both. Where it is
  // ambiguous the direction to be wrong in is the expensive one: this row's
  // job is to refuse a discount nobody earned.
  const snap = areaTree({ subs: [{ name: "web-a", body: 60, mods: ["A.tsx"] }, { name: "web-b", body: 40, mods: ["A.tsx"] }] });
  const shared = areaHistory(["A.tsx"]);
  assert.equal(measureContext(snap, shared, 0, CFG).value.areas["web"].expected, 1000 + 100 + 60 + 40);

  const orphan = areaHistory(["Z.tsx"]);
  assert.equal(
    measureContext(snap, orphan, 0, CFG).value.areas["web"].expected,
    1000 + 100,
    "you read the map, it names nothing, you read the code — the router alone, not zero",
  );
});

test("an area nobody has touched reports its ceiling and no expected", () => {
  const snap = areaTree({ subs: [{ name: "web-a", body: 60, mods: ["A.tsx"] }] });
  const elsewhere = {
    commits: [{ sha: "c0", ts: 0, day: "2026-01-01", subject: "host", filesTouched: ["packages/host/src/main.ts"], batch: false }],
    touches: new Map(),
    batch: new Set(),
  };
  const web = measureContext(snap, elsewhere, 0, CFG).value.areas["web"];
  assert.equal(web.ceiling, 1000 + 100 + 60, "the ceiling is a fact about the tree and is there whatever the history says");
  assert.equal(web.expected, null, "an expected of 0 would read as an area that costs nothing to enter");
  assert.equal(web.p90, null);
  assert.equal(web.commits, 0, "the denominator travels with the median, as it does for the re-touch rate");
});

test("an area whose router is not among the counted skills is omitted, not floored", () => {
  // The areas are derived from the tree, so this is the case where the two
  // disagree: `COUNT_GENERATED_SKILLS` can filter a router out of the set
  // being costed after `snapshot.mjs` derived the area over all of them.
  const snap = areaTree({ subs: [] });
  snap.skills = snap.skills.filter((s) => s.name !== "web");
  snap.skills.push({ name: "shared", descriptionChars: 0, bodyChars: 10, generated: false, headModules: [] });
  snap.areas = [...snap.areas, { router: "shared", src: "packages/shared", also: [] }];
  const areas = measureContext(snap, areaHistory(["A.tsx"]), 0, CFG).value.areas;
  assert.equal("web" in areas, false, "CLAUDE.md + descriptions is a real number for a file that does not exist");
  assert.equal("shared" in areas, true);
});

test("an area whose router names no source group reports its ceiling and says why", () => {
  // `src: null` is what `snapshot.mjs` reports when a router's description
  // names no group, or two equally specific ones. No commit can be
  // attributed, so the per-commit reading is absent WITH A REASON — and the
  // ceiling still reports, because the prose exists whatever the history says.
  const snap = areaTree({ subs: [{ name: "web-a", body: 60, mods: ["A.tsx"] }] });
  snap.areas = [{ router: "web", src: null, also: [] }];
  const web = measureContext(snap, areaHistory(["A.tsx"]), 0, CFG).value.areas["web"];
  assert.equal(web.ceiling, 1000 + 100 + 60);
  assert.equal(web.expected, null);
  assert.equal(web.p90, null);
  assert.equal(web.commits, null, "0 commits and no way to count them are different claims");
  assert.match(web.reason, /no source group/);
});

test("an empty `areas` carries a reason, because an empty object is two claims", () => {
  // Almost every row in this repo's own history has no areas at all — the
  // first sha with a `<router>-*` skill is commit 156 of 170 — and on a chart
  // that is indistinguishable from a repo with no router convention. Both are
  // absences, and an absence in this tool carries a reason.
  const snap = areaTree({ subs: [] });
  snap.areas = [];
  const value = measureContext(snap, areaHistory(["A.tsx"]), 0, CFG).value;
  assert.deepEqual(value.areas, {});
  assert.match(value.areasReason, /router/);
  assert.equal(typeof value.claudeMdChars, "number", "the repo-wide always-on weight still reads");
});

test("a CLAUDE.md is measured whether or not there are skills beside it", () => {
  // Eight of the thirteen repos on this desktop that have a CLAUDE.md have no
  // `.claude/skills` directory, and every one of them used to report the
  // whole context row absent "no .claude/skills at this commit" — a reason
  // about skills standing in for a series whose card promises the size of
  // this repo's CLAUDE.md. An absence has to be about the thing that is
  // absent.
  const snap = areaTree({ subs: [] });
  snap.skills = [];
  snap.areas = [];
  const got = measureContext(snap, areaHistory(["A.tsx"]), 0, CFG);
  assert.equal(got.value.claudeMdChars, 1000, "the file is in the tree and has a length");

  // And the two numbers that ARE about the split stay absent, together,
  // because they describe one population — a count beside an unmeasured
  // total would be two claims about the same set.
  assert.equal(got.value.descChars, null);
  assert.equal(got.value.skillCount, null);
  assert.match(got.value.skillsReason, /\.claude\/skills/);

  // No CLAUDE.md is still the whole row absent, and now says which file.
  snap.claudeMdChars = null;
  const none = measureContext(snap, areaHistory(["A.tsx"]), 0, CFG);
  assert.equal(none.value, null);
  assert.match(none.reason, /CLAUDE\.md/);
});

test("a tree whose only skills are generated says so, and not that there are none", () => {
  // `COUNT_GENERATED_SKILLS` filtering the set empty is a fact about a
  // constant in this engine; "no .claude/skills at this commit" is a fact
  // about the repo. The old sentence said the second in both cases.
  const snap = areaTree({ subs: [] });
  snap.skills = [{ name: "visual-check", descriptionChars: 300, bodyChars: 9000, generated: true, headModules: [] }];
  snap.areas = [];
  const prereg = { ...CFG, COUNT_GENERATED_SKILLS: false };
  const got = measureContext(snap, areaHistory(["A.tsx"]), 0, prereg);
  assert.equal(got.value.claudeMdChars, 1000);
  assert.equal(got.value.skillCount, null);
  assert.match(got.value.skillsReason, /generated/);
  assert.doesNotMatch(got.value.skillsReason, /^no \.claude\/skills/);
});

// ───────────────────────────────────────────────────────────────────────────
// The narrative: silent when nothing moved, never a verdict, never a bare number.
// ───────────────────────────────────────────────────────────────────────────

test("nothing moved means nothing is said", () => {
  const fixture = JSON.parse(readFileSync(join(TOOL_DIR, "fixture.json"), "utf8"));
  const row = fixture.rows[fixture.rows.length - 1];
  const twin = JSON.parse(JSON.stringify(row));
  assert.deepEqual(events([], [row], PREREG), events([], [row], PREREG));
  assert.deepEqual(events([row], [twin], PREREG), [], "two identical days produce no sentence");
  assert.equal(render([]), "", "and no sentences produce no text");
});

test("every sentence names the number it is comparing against", () => {
  const fixture = JSON.parse(readFileSync(join(TOOL_DIR, "fixture.json"), "utf8"));
  const evs = events([], perDay(fixture.rows), PREREG);
  assert.ok(evs.length > 0, "the committed history moved somewhere");
  for (const e of evs) {
    assert.ok(
      numbersIn(e.text).length >= 2,
      `a value with no comparator is unreadable on a phone: ${JSON.stringify(e.text)}`,
    );
  }
});

/** A verdict is a word that decides for the reader. None of them may appear in
 *  anything this tool writes — a sentence, a chart label, a detail line. */
const VERDICT_WORDS = ["score", "grade", "healthy", "unhealthy", "good", "bad", "should"];

const assertNoVerdict = (text, where) => {
  for (const word of VERDICT_WORDS) {
    assert.doesNotMatch(
      text,
      new RegExp(`\\b${word}\\b`, "i"),
      `"${word}" is a verdict in ${where}. This tool reads; it does not judge, and nothing it writes applies itself.`,
    );
  }
};

test("the narrative never grades", () => {
  const fixture = JSON.parse(readFileSync(join(TOOL_DIR, "fixture.json"), "utf8"));
  assertNoVerdict(render(events([], perDay(fixture.rows), PREREG)), "the narrative");
});

// ───────────────────────────────────────────────────────────────────────────
// `plot`: the tool STATES, the client draws.
//
// Everything a chart compares against — the rank, the slope, how long the
// window was, the day it opens, why a reading is missing — is computed here
// and shipped as text and numbers. The assertions below are all one rule: the
// plot's reading must BE the narrative's reading, not a second one that agrees
// today. A copy on the drawing end would sit outside `constants.mjs` and the
// fixture entirely, which is the mechanism that makes a definition change
// loud.
//
// Read over the COMMITTED fixture (`plot --fixture`), not `.waterplane`: a clone
// with no series of its own must still be able to run this, and what is
// pinned has to be the history the fixture records.
// ───────────────────────────────────────────────────────────────────────────

const CLI = join(ROOT, "tools", "repohealth.mjs");
const PLOT = join(TOOL_DIR, "plot.mjs");

const runPlot = (args = ["--fixture"]) =>
  execFileSync(process.execPath, [CLI, "plot", ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

let plotMemo = null;
const plotDoc = () => (plotMemo ??= JSON.parse(runPlot()));

/** The readings of one plotted series, oldest first — absences dropped, which
 *  is what `windowFor` does in `narrate.mjs` before a rank is taken. */
const readingsOf = (s) => s.points.filter((p) => p.v !== null).map((p) => ({ day: p.day, v: p.v }));

test("plot is one JSON line, exits 0, and says which window a rank was taken in", () => {
  const raw = runPlot();
  assert.equal(raw.trim().split("\n").length, 1, "one line, so a caller can read it without a parser");
  const doc = JSON.parse(raw);
  const fixture = JSON.parse(readFileSync(join(TOOL_DIR, "fixture.json"), "utf8"));
  // The series' own version, which the test above pins to CFG.VERSION wherever the history is here.
  assert.equal(doc.preregVersion, fixture.prereg);
  assert.equal(doc.days, fixture.rows.length);
  // Shipped so nothing on the drawing end hardcodes 60 and 14 — the pair that
  // decides what "recent" means and when there is a rank at all.
  assert.equal(doc.windowReadings, PREREG.RANK_WINDOW_DAYS);
  assert.equal(doc.minReadings, PREREG.RANK_MIN_POINTS);
});

test("plot never writes, and does not touch the series", () => {
  const before = readFileSync(join(TOOL_DIR, "fixture.json"), "utf8");
  runPlot();
  assert.equal(readFileSync(join(TOOL_DIR, "fixture.json"), "utf8"), before);
  // The one real write path is `update --fixture`; `plot` shares the flag name
  // and must not share the behaviour. The shaping moved to `plot.mjs`, so the
  // text check follows it there — that is where a write would be added.
  assert.doesNotMatch(
    readFileSync(PLOT, "utf8").split("export function buildPlot(")[1].split("\n/**")[0],
    /writeFileSync|append\(/,
    "plot is read-only",
  );
});

test("every plotted series is one the narrative knows", () => {
  const doc = plotDoc();
  assert.deepEqual(
    doc.series.map((s) => s.key),
    SERIES.map((s) => s.key),
    "the plot's series list is the narrative's, imported — not a second list that goes stale",
  );
  for (const s of doc.series) {
    const def = SERIES.find((d) => d.key === s.key);
    assert.equal(s.label, def.label);
    assert.equal(s.unit, def.unit);
  }
});

/**
 * A metric a reader cannot look up is a metric they have to guess at.
 *
 * The phone draws a `?` beside every series on the repo-readings sheet, keyed
 * `repohealth.<series key>` against the catalog in
 * `packages/shared/src/hints.ts`. A chip whose id has no definition renders
 * nothing at all — the repo's rule that a thing which cannot act is absent
 * rather than dimmed — which is right for one tile and quietly wrong for a
 * sheet: five explained tiles and a sixth with no chip reads as "that one is
 * self-explanatory", not as a missing entry.
 *
 * So the check lives HERE, beside the list that decides what the sheet shows,
 * and it is a text match rather than an import: this tool is plain `.mjs` run
 * straight by `node --test`, and the catalog is TypeScript that would have to
 * be built first. The failure mode a build step would add — a stale `dist`
 * passing a check about source — is exactly the kind this file refuses
 * elsewhere.
 */
test("every plotted series has a help entry the phone can show", () => {
  // Comments stripped first, and the key matched with its opening brace: the
  // point of the check is that an ENTRY exists, and `hints.includes("…")`
  // alone is satisfied by the id appearing in a comment — or by the entry it
  // is meant to guard being commented out during a reword, which is exactly
  // the edit that would silently drop a chip.
  const hints = readFileSync(join(ROOT, "packages", "shared", "src", "hints.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
  for (const s of SERIES) {
    assert.match(
      hints,
      new RegExp(`"repohealth\\.${s.key.replace(/\./g, "\\.")}"\\s*:\\s*\\{`),
      `no hint entry for ${s.key} — the sheet would draw that tile with no ? beside it`,
    );
  }
});

/**
 * A series that is drawn and never placed.
 *
 * The skill count is the case this exists for: in a young repo it rises
 * BECAUSE reference is leaving the always-on file, which is the move the
 * context row was built to show, and in an older one the same rise is a split
 * gone too far. One number, two readings, and a percentile cannot tell them
 * apart — so it is plotted with the tool's reason where the rank would be,
 * and the two sentences `seriesEvents` writes about a series are never
 * written about this one. Both halves are checked, because either alone
 * leaves the number half-graded: a rank with no sentence still prints an
 * ordinal on the tile, and a sentence with no rank still says it moved.
 */
test("a plain series is drawn, and carries a reason where its rank would be", () => {
  const doc = plotDoc();
  const s = doc.series.find((x) => x.key === "context.skillCount");
  assert.ok(s, "the plain series is on the plot — unranked is not unplotted");
  assert.ok(s.points.some((p) => p.v !== null), "with points to draw");
  assert.equal(s.reading.rank, null, "no percentile");
  assert.equal(s.reading.slope, null, "and no arrow: the two say the same thing");
  assert.equal(s.reading.reason, PLAIN_REASON);
  assert.ok(s.reading.reason.length > 0, "a null rank always says why");
  for (const word of ["score", "grade", "healthy", "unhealthy", "good", "bad", "should"]) {
    assert.doesNotMatch(s.reading.reason, new RegExp(`\\b${word}\\b`, "i"), `"${word}" is a verdict`);
  }
});

test("a null rank takes the slope with it, plain or merely short", () => {
  // The claim the tile depends on: `Slope` draws nothing when the tool gives
  // none, so the arrow disappearing is the reading's job and not the phone's.
  const short = Array.from({ length: PREREG.RANK_MIN_POINTS - 1 }, (_, i) => ({ day: `2026-03-0${(i % 9) + 1}`, v: i }));
  const thin = reading(readRank, short, PREREG);
  assert.equal(thin.rank, null);
  assert.equal(thin.slope, null, "a rank nobody could compute cannot have a direction");
  assert.ok(thin.reason);

  const long = Array.from({ length: 30 }, (_, i) => ({ day: "2026-03-01", v: i }));
  const ranked = reading(readRank, long, PREREG);
  assert.equal(typeof ranked.rank, "number", "the same window IS rankable");
  assert.equal(reading(readRank, long, PREREG, { plain: true }).rank, null, "and plain refuses it anyway");
  assert.equal(reading(readRank, long, PREREG, { plain: true }).slope, null);
});

test("a plain series says nothing, however it moves", () => {
  // Its ranked TWIN carries the identical numbers on the identical days, so
  // the only difference between the two series is the flag. Anything the twin
  // fires is something this series would have fired.
  const rows = Array.from({ length: 28 }, (_, i) => {
    const v = i < 14 ? 1400 - i * 100 : 100 + (i - 13) * 100; // a V: quartiles crossed, slope turned
    return {
      sha: `s${i}`,
      day: `2026-03-${String(i + 1).padStart(2, "0")}`,
      ts: i * 86400,
      batch: false,
      prereg: CFG.VERSION,
      size: { value: null, reason: "not measured in this fixture" },
      retouch: { value: null, reason: "not measured in this fixture" },
      hatches: { value: null, reason: "not measured in this fixture" },
      dups: { value: null, reason: "not measured in this fixture" },
      cochange: { value: null, reason: "not measured in this fixture" },
      context: { value: { claudeMdChars: 1000, descChars: v, skillCount: v, areas: {} } },
      untested: { value: null, reason: "not measured in this fixture" },
      classics: { value: null, reason: "not measured in this fixture" },
      tripwires: [],
    };
  });

  const kinds = new Map();
  for (const e of events([], rows, PREREG)) {
    if (e.kind !== "rank" && e.kind !== "slope") continue;
    const subject = e.id.split(":")[1];
    kinds.set(subject, (kinds.get(subject) ?? new Set()).add(e.kind));
  }
  assert.deepEqual(
    [...(kinds.get("context.descChars") ?? [])].sort(),
    ["rank", "slope"],
    "the ranked twin fires both sentences over this shape — otherwise the test below proves nothing",
  );
  assert.equal(
    kinds.has("context.skillCount"),
    false,
    "and the plain series fires neither, over the very same numbers",
  );
});

test("a plotted reading IS the narrative's reading of the same window", () => {
  const doc = plotDoc();
  for (const s of doc.series) {
    const def = SERIES.find((d) => d.key === s.key);
    const full = readingsOf(s);
    // Deep-equal against `readings.mjs`'s own `reading`, JSON-normalised
    // because `reason` is `undefined` — absent from the wire — when there is
    // a rank. The DEFINITION goes in too: whether a series is ranked at all
    // is part of the reading, and reproducing it here without the definition
    // would be the second definition this test exists to forbid.
    assert.deepEqual(
      s.reading,
      JSON.parse(JSON.stringify(reading(readRank, full, PREREG, def))),
      `${s.key}: the plot read its own rank`,
    );
    // And against `readRank` directly over the same cut, which is the thing
    // `reading` is a wrapper around: two definitions of a percentile once
    // shipped exactly one value in production, `0th`. A plain series is the
    // one case where the two legitimately differ — `readRank` would happily
    // place it, and the point is that nothing does.
    const win = full.slice(-PREREG.RANK_WINDOW_DAYS);
    const raw = readRank(win.map((p) => p.v), PREREG);
    assert.equal(s.reading.rank, def.plain ? null : raw.rank);
    assert.equal(s.reading.slope, def.plain || raw.rank === null ? null : raw.slope);
  }
});

test("n and from describe the window that was actually cut", () => {
  const doc = plotDoc();
  for (const s of doc.series) {
    const win = readingsOf(s).slice(-PREREG.RANK_WINDOW_DAYS);
    assert.equal(s.reading.n, win.length, `${s.key}: n counts READINGS, not calendar days`);
    assert.equal(s.reading.from, win.length ? win[0].day : null, `${s.key}: the window has to be locatable`);
    if (s.reading.rank === null) {
      // Never a rank of 0 on a short history — that is the opposite claim.
      assert.equal(typeof s.reading.reason, "string");
      assert.ok(s.reading.reason.length > 0, `${s.key}: an absent rank says why`);
    } else {
      assert.ok(s.reading.rank >= 0 && s.reading.rank <= 1, `${s.key}: a rank is a fraction`);
      assert.ok(["rising", "falling", "flat"].includes(s.reading.slope), `${s.key}: a slope is a sign`);
    }
  }
});

test("a point is a day, a sha and a value — and never an instant", () => {
  const doc = plotDoc();
  const families = [...doc.series.map((s) => [s.key, s.points])];
  for (const k of ["loc", "files", "deps"]) families.push([`classics.${k}`, doc.classics[k]]);
  for (const p of doc.classics.packages) families.push([`classics.packages.${p.pkg}`, p.points]);
  for (const t of doc.classics.types ?? []) families.push([`classics.types.${t.ext}`, t.points]);
  for (const [key, points] of families) {
    assert.equal(points.length, doc.days, `${key}: one point per day, so every line shares one axis`);
    for (const p of points) {
      assert.deepEqual(
        Object.keys(p).sort(),
        ["day", "sha7", "v"],
        // A `ts` here would re-open the seconds/millisecond trap that shipped
        // "last commit 690mo ago" to a phone. The day string is the x label.
        `${key}: a point carries no field beyond its day, its sha and its value`,
      );
      assert.match(p.day, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(p.sha7.length, 7);
      assert.ok(p.v === null || Number.isFinite(p.v), `${key}: a value is a number or null, never a repaired 0`);
    }
  }
});

test("an absence is a reason, and a reason is never a zero", () => {
  const doc = plotDoc();
  const fixture = JSON.parse(readFileSync(join(TOOL_DIR, "fixture.json"), "utf8"));
  const last = fixture.rows[fixture.rows.length - 1];
  for (const s of doc.series) {
    const family = s.key.split(".")[0];
    const missing = last[family]?.value === null || last[family]?.value === undefined;
    assert.equal("absent" in s, missing, `${s.key}: absent is present exactly when the family read nothing`);
    if (missing) {
      assert.equal(typeof s.absent, "string");
      assert.ok(s.absent.length > 0);
      assert.equal(s.last, null, "an absent family reports no value, never 0");
    }
  }
  // Hand-built rows: a family that stops reading must produce a null point and
  // a stated reason, not a line that dives to the floor.
  const blinded = fixture.rows.map((r, i) =>
    i === fixture.rows.length - 1 ? { ...r, untested: { value: null, reason: "typescript did not load" } } : r,
  );
  const s = SERIES.find((d) => d.key === "untested.count");
  assert.equal(s.get(blinded[blinded.length - 1]), null, "the series reads null, not 0");
});

test("the plot never grades either", () => {
  const doc = plotDoc();
  for (const s of doc.series) {
    assertNoVerdict(s.label, `the label of ${s.key}`);
    assertNoVerdict(s.detail, `the detail of ${s.key}`);
    if (s.absent) assertNoVerdict(s.absent, `the absence of ${s.key}`);
  }
});

test("a detail carries the numbers the value came from, or says nothing at all", () => {
  const doc = plotDoc();
  for (const s of doc.series) {
    if (!s.detail) continue;
    assert.ok(
      numbersIn(s.detail).length >= 2,
      `a rate with one number is unreadable: ${JSON.stringify(s.detail)}`,
    );
  }
});

test("the latest day's context and classics ride along, whole or absent", () => {
  const doc = plotDoc();
  for (const [area, a] of Object.entries(doc.context.areas)) {
    // The five numbers, and — only where the area could not be attributed to
    // any commit — the sentence that says which kind of null the nulls are.
    const keys = Object.keys(a).sort();
    assert.deepEqual(keys.filter((k) => k !== "reason"), ["ceiling", "commits", "expected", "p90", "subs"], `area ${area}`);
    for (const [k, v] of Object.entries(a)) {
      if (k === "reason") {
        assert.ok(typeof v === "string" && v.length > 0, `${area}.reason`);
        assert.equal(a.expected, null, `${area}: a reason stands where a reading would be, never beside one`);
        continue;
      }
      assert.ok(v === null || Number.isFinite(v), `${area}.${k}`);
    }
  }
  assert.ok(doc.classics.tape === null || Array.isArray(doc.classics.tape));
  for (const v of doc.classics.tape ?? []) assert.ok(Number.isFinite(v), "the tape is line counts, nothing else");
  for (const p of doc.classics.packages) assert.equal(typeof p.pkg, "string");
});

// ───────────────────────────────────────────────────────────────────────────
// Scopes: one subtree, measured as though it were the repo.
// ───────────────────────────────────────────────────────────────────────────

test("a scope is a path inside the repo, and anything else is refused", () => {
  // Refused, never sanitised. A scope is a thing a person named, and measuring
  // a different subtree than the one they typed is the failure every path
  // guard in this codebase exists for.
  assert.equal(normalizeScope("apps/ba3-web/"), "apps/ba3-web");
  assert.equal(normalizeScope("./apps/ba3-web"), "apps/ba3-web");
  for (const bad of ["", "   ", "/etc", "../sibling", "apps/../../etc", "apps/./web"]) {
    assert.throws(() => normalizeScope(bad), /scope/, `${JSON.stringify(bad)} must not resolve to a scope`);
  }
});

test("two scopes never share a series file, however they are spelled", () => {
  // The flattening is lossy on purpose — a path is not a filename — so the
  // hash is what keeps `a/b` and `a-b` apart. Without it they would append to
  // one file, and every reader of that file is written for one history.
  assert.notEqual(slugFor("apps/web"), slugFor("apps-web"));
  assert.equal(slugFor("apps/web"), slugFor("apps/web/"), "the same scope is the same file");
  assert.match(slugFor("apps/ba3-web"), /^apps-ba3-web-[0-9a-f]{4}$/);
});

test("a scoped history holds only the commits that touched the subtree", () => {
  const history = { ...git.readHistory(ROOT, CFG), hunks: HUNKS() };
  const scoped = scopeHistory(history, "tools", CFG);
  assert.ok(scoped.commits.length > 0, "this repo has commits under tools/");
  assert.ok(
    scoped.commits.length < history.commits.length,
    "and not every commit touched it — otherwise this assertion proves nothing",
  );
  for (const c of scoped.commits) {
    assert.ok(c.filesTouched.length, "a commit with nothing in scope is dropped, never kept empty");
    for (const p of c.filesTouched) {
      // RE-ROOTED: everything below the boundary measures the subtree as a
      // repo, so a path that still carried `tools/` would put every file in
      // the wrong group and look for a CLAUDE.md that is not there.
      assert.ok(!p.startsWith("tools/"), `${p} still carries the scope prefix`);
    }
  }
});

test("a scoped snapshot is the subtree, measured as a repo", () => {
  const history = { ...git.readHistory(ROOT, CFG), hunks: HUNKS() };
  const head = history.commits[history.commits.length - 1];
  const whole = buildSnapshot(ROOT, head.sha, git, CFG);
  const part = buildSnapshot(ROOT, head.sha, git, CFG, "packages/web");
  assert.ok(part.files.length > 0 && part.files.length < whole.files.length);
  for (const f of part.files) assert.ok(!f.path.startsWith("packages/web/"), `${f.path} is not re-rooted`);
  // Its own groups, derived from its own top level — not the repo's.
  assert.ok(part.groups.includes("src"), `expected a src group, got ${JSON.stringify(part.groups)}`);
  assert.ok(!part.groups.includes("packages/web"));
  // And its own instructions: this subtree has no CLAUDE.md, which is an
  // absence about the subtree rather than the repo's file counted twice.
  assert.equal(part.claudeMdChars, null);
  assert.ok(typeof whole.claudeMdChars === "number");
});

test("a scoped census is the subtree's languages, not the repo's", () => {
  // Activation is "which languages are in this tree", and under a scope the
  // tree IS the subtree. Read from the repo, a polyglot monorepo would hand a
  // one-language app the whole fleet's packs — and every absence that app
  // reports would carry a denominator counted somewhere else.
  const whole = configure(ROOT, git);
  const part = configure(ROOT, git, undefined, "tools");
  const filesOf = (cfg, name) => cfg.PACKS.find((p) => p.name === name)?.files ?? null;
  assert.ok(filesOf(part, "typescript") > 0, "tools/ is full of .mjs");
  assert.ok(
    filesOf(part, "typescript") < filesOf(whole, "typescript"),
    "and a subtree's count is its own, never the repo's",
  );
});

test("the per-type cut of the tree adds up to the same tree", () => {
  // The whole claim of drawing this chart beside the group chart is that they
  // are one quantity cut two ways. If the two totals can differ, they are two
  // measurements wearing one label, and a reader comparing the top edges is
  // being shown a difference that is really a bug in one of the cuts.
  const history = { ...git.readHistory(ROOT, CFG), hunks: HUNKS() };
  const head = history.commits[history.commits.length - 1];
  const snap = buildSnapshot(ROOT, head.sha, git, CFG);
  const value = measureClassics(snap, history, history.commits.length - 1, CFG).value;
  const types = value.types;
  assert.ok(Array.isArray(types) && types.length, "a tree with source has at least one type in it");
  assert.equal(types.reduce((n, t) => n + t.loc, 0), value.loc, "every source line is under exactly one type");
  assert.equal(types.reduce((n, t) => n + t.files, 0), value.files, "and so is every source file");
  // Name order, for the reason `packages` is in name order: a colour on the
  // drawing end follows a key, and a key whose position depends on its size
  // this morning is a colour that changes hands mid-curve.
  assert.deepEqual([...types].map((t) => t.ext).sort(), types.map((t) => t.ext));
  for (const t of types) {
    // The extension as the packs spell it — never a split on the last dot,
    // which files `types.d.ts` under `.ts` and `index.spec.ts` under `.spec`.
    assert.ok(t.ext.startsWith("."), `${t.ext}: an extension, with its dot`);
    assert.ok(t.pack === null || typeof t.pack === "string", `${t.ext}: a pack name or nothing`);
  }
});

test("plot reads the live series the same way html does", (t) => {
  // The fixture path is hermetic; this is the one that exercises the real
  // read — stale shas filtered, a mixed series warned about on stderr and
  // drawn anyway. Skipped where nothing has been measured yet, which is the
  // normal state of a fresh clone.
  if (!existsSync(stateFile(ROOT, "repohealth.jsonl"))) {
    t.skip("no repohealth.jsonl under this clone's state dir");
    return;
  }
  const doc = JSON.parse(runPlot([]));
  assert.equal(doc.windowReadings, PREREG.RANK_WINDOW_DAYS);
  assert.ok(doc.days >= 1);
  assert.deepEqual(
    doc.series.map((s) => s.key),
    SERIES.map((s) => s.key),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// The token guard.
// ───────────────────────────────────────────────────────────────────────────

test("only judge.mjs can reach a model", () => {
  for (const f of toolSources()) {
    if (f.path.endsWith("judge.mjs")) continue;
    const code = f.text.replace(/\/\*[\s\S]*?\*\/|(^|\s)\/\/[^\n]*/g, "");
    assert.doesNotMatch(
      code,
      /["'`]claude["'`]/,
      `${f.path} names "claude" outside a comment. The whole series is free — git, regex and local\n` +
        "computation — and it stays free only because exactly one module may spawn a model.",
    );
    assert.doesNotMatch(code, /child_process[\s\S]{0,80}claude/, `${f.path} may not spawn claude`);
  }
});

test("the free path cannot even load judge.mjs", () => {
  for (const f of toolSources()) {
    if (f.path.endsWith("repohealth.mjs") && !f.path.includes("/repohealth/")) {
      // The CLI may reach it, but only lazily, from inside the one branch.
      assert.doesNotMatch(
        f.text,
        /^import[^\n]*judge\.mjs/m,
        "judge.mjs must be a dynamic import inside the judge branch, so no other command can pull it in",
      );
      continue;
    }
    // Comments may discuss it — the header of `constants.mjs` explains the
    // guard, and a rule nobody can describe is a rule nobody keeps. What must
    // not exist is a reference the module loader can follow.
    const code = f.text.replace(/\/\*[\s\S]*?\*\/|(^|\s)\/\/[^\n]*/g, "");
    assert.doesNotMatch(code, /judge\.mjs/, `${f.path} must not import or reference judge.mjs in code`);
  }
});

test("judge spends nothing without an explicit yes", async () => {
  let calls = 0;
  const spawn = () => {
    calls++;
    throw new Error("a model was spawned without confirmation");
  };
  const b = await bundle({ id: "dups:x:deadbeef" }, ROOT, { prereg: PREREG });
  const res = await run(b, { confirm: false, spawn, stdin: { isTTY: false }, root: ROOT, write: () => {} });
  assert.equal(calls, 0, "no confirmation, no spend");
  assert.equal(res.code, 2, "declining is exit 2 — the guard working, not a failure");
});

test("judge says what it would cost before it could spend anything", async () => {
  const b = await bundle({ id: "dups:x:deadbeef" }, ROOT, { prereg: PREREG });
  assert.equal(typeof b.chars, "number");
  assert.ok(b.chars <= PREREG.JUDGE_MAX_CHARS, "the bundle is capped, and the cap is pre-registered");
  const lines = [];
  await run(b, { confirm: false, spawn: () => {}, stdin: { isTTY: false }, root: ROOT, out: (l) => lines.push(l), write: () => {} });
  assert.match(lines.join("\n"), /chars|tokens/i, "the estimate is printed before the question is asked");
});

// ───────────────────────────────────────────────────────────────────────────
// Drift in the block itself.
// ───────────────────────────────────────────────────────────────────────────

test("the pre-registered block is frozen and nothing in it is dead", () => {
  assert.ok(Object.isFrozen(PREREG));
  const all = toolSources().map((f) => f.text).join("\n");
  for (const key of Object.keys(PREREG)) {
    assert.ok(
      all.includes(key),
      `PREREG.${key} is read by nothing. A constant nobody uses is a decision that looks pinned and is not.`,
    );
  }
});

test("the fixture is not so large it stops being reviewable", () => {
  const bytes = statSync(join(TOOL_DIR, "fixture.json")).size;
  assert.ok(
    bytes < 1_000_000,
    `fixture.json is ${bytes} bytes. It is committed and it is read in diffs; past a megabyte it is\n` +
      "no longer something a person can review, which defeats the point of committing it.",
  );
});

// ───────────────────────────────────────────────────────────────────────────
// Two bugs that shipped because every test agreed with the code that had them.
// ───────────────────────────────────────────────────────────────────────────

test("a percentile is a real percentile, not a fraction printed as an ordinal", () => {
  // There were once two `readRank`s on two scales — [0,1] in `series.mjs` and
  // [0,100] in `narrate.mjs` — and the CLI injected the first into a
  // formatter that assumed the second. Production therefore emitted exactly
  // one percentile in its whole history, `0th`, which reads as "the lowest
  // this has ever been" and is the one claim the no-threshold design must
  // never make by accident. Nothing caught it: the tests exercised the copy
  // production does not use. So the assertion is on the rendered sentence.
  const fixture = JSON.parse(readFileSync(join(TOOL_DIR, "fixture.json"), "utf8"));
  const text = render(events([], perDay(fixture.rows), PREREG));
  assert.doesNotMatch(text, /\b0th percentile\b/, "a mid-rank percentile can never be 0 — this is a scale mismatch, not a reading");
  for (const [, n] of text.matchAll(/\b(\d+)(?:st|nd|rd|th) percentile\b/g)) {
    const v = Number(n);
    assert.ok(v >= 1 && v <= 100, `${v}th percentile is off the scale`);
  }
});

test("a second commit on a day already reported repeats nothing", () => {
  // Event ids were `kind:subject:sha`, and `perDay` re-picks the day's last
  // commit — so an evening `update` after a morning one changed every id and
  // replayed the whole day at the reader. That is the most common cadence
  // there is, and "never repeats what it already said" is the rule that makes
  // silence mean something.
  const fixture = JSON.parse(readFileSync(join(TOOL_DIR, "fixture.json"), "utf8"));
  const days = perDay(fixture.rows);
  const before = events([], days, PREREG);
  const later = days.map((r, i) =>
    i === days.length - 1 ? { ...r, sha: "0".repeat(40), ts: r.ts + 3600 } : r,
  );
  const after = events([], later, PREREG);
  assert.deepEqual(
    after.map((e) => e.id).sort(),
    before.map((e) => e.id).sort(),
    "the same day reported twice under a new sha must produce the same event ids, or the reader sees it all again",
  );
});

// ───────────────────────────────────────────────────────────────────────────
// The tape is written as objects and read as numbers.
// ───────────────────────────────────────────────────────────────────────────

test("the tape's paths line up with its line counts, bar for bar", () => {
  // The phone names the bar under the finger by INDEX into both lists, so a
  // hole the counts drop must be dropped from the paths too, or every bar
  // after it names its neighbour's file.
  const raw = [{ path: "a.ts", loc: 30 }, { path: "gap.ts" }, { path: "b.ts", loc: 10 }, 5];
  assert.deepEqual(tapeLines(raw), [30, 10, 5]);
  assert.deepEqual(tapePaths(raw), ["a.ts", "b.ts", null], "a bare number is a bar with no name");
  assert.deepEqual(tapePaths(null), []);
});

test("the tape reads as line counts whichever shape the row holds", () => {
  // The row writes `{path, loc}`. Two readers want the numbers, and one of
  // them did its own conversion while the other did not: `html.mjs` handed
  // the objects to arithmetic, which JavaScript answers with `NaN` and no
  // error. The page rendered an empty box — every bar height NaN, `sort`
  // a no-op because `obj - obj` is NaN, the median an em dash, and the p95
  // rule parked at the right edge because no object is `>=` a number.
  assert.deepEqual(
    tapeLines([{ path: "a.ts", loc: 30 }, { path: "b.ts", loc: 10 }]),
    [30, 10],
    "the tape's own order is kept — sorting is the caller's business",
  );
  assert.deepEqual(tapeLines([30, 10]), [30, 10], "a bare number is accepted too");
  assert.deepEqual(tapeLines([{ path: "a.ts" }, { path: "b.ts", loc: 7 }]), [7], "a hole is dropped, never zeroed");
  assert.deepEqual(tapeLines(null), []);
  assert.deepEqual(tapeLines(undefined), []);
});

test("nothing renders the tape by doing arithmetic on the row's objects", () => {
  // The guard that keeps the fix from being undone by the next person who
  // needs the numbers: every reader goes through `tapeLines`.
  const html = readFileSync(new URL("./repohealth/html.mjs", import.meta.url), "utf8");
  assert.match(html, /tapeLines\(/, "html.mjs converts before it draws");
  const plot = readFileSync(new URL("./repohealth/plot.mjs", import.meta.url), "utf8");
  assert.match(plot, /tapeLines\(/, "and so does the plot the phone reads");
});

test("the plot sends packages by NAME, so a colour never follows a size", () => {
  // The phone hands out palette slots by POSITION. Largest-first here means
  // the day `host` overtakes `web` the two swap blue and orange along their
  // whole history, and a reader re-reads every past day as the other
  // package. Name order is stable for as long as a package keeps its name,
  // which is the only thing about it that should decide a hue.
  // The committed fixture, not the live series: a clone has none until `update` has run.
  const plot = plotDoc();
  const names = plot.classics.packages.map((p) => p.pkg);
  assert.deepEqual(names, [...names].sort(), `packages arrived as ${names.join(", ")}`);
  assert.ok(names.length >= 2, "this repo has several packages; a one-package assertion proves nothing");
});

test("which groups fold is decided by size here, and the order is still by name", () => {
  // Name order alone decides the fold when the phone keeps the first few, and
  // the first few alphabetically are not the few worth drawing: this repo drew
  // `.`, `deploy` and `packages/app` — 158, 122 and 140 lines — and folded
  // `packages/web` and `packages/host` into the hueless remainder. So `rank`
  // says which are the largest on the latest day, and the phone folds by it
  // while still assigning a slot by name. Membership is the tool's; the hue
  // and the number of slots are the drawing's.
  // The committed fixture, not the live series: a clone has none until `update` has run.
  const plot = plotDoc();
  const pkgs = plot.classics.packages;
  assert.ok(pkgs.length >= 5, `fold membership only matters past a full palette; got ${pkgs.length}`);

  const ranks = pkgs.map((p) => p.rank).sort((a, b) => a - b);
  assert.deepEqual(ranks, pkgs.map((_, i) => i), "every group has a rank and no two share one");

  // The rank is the latest day's order, largest first.
  const lastOf = (p) => p.points[p.points.length - 1]?.v ?? null;
  const byRank = [...pkgs].sort((a, b) => a.rank - b.rank).map(lastOf);
  for (let i = 1; i < byRank.length; i++) {
    assert.ok(
      byRank[i - 1] >= byRank[i],
      `rank ${i} is larger than rank ${i - 1} (${byRank[i]} > ${byRank[i - 1]})`,
    );
  }
  // And the array itself is still by name, so a slot does not move when a
  // group grows past another overnight.
  const names = pkgs.map((p) => p.pkg);
  assert.deepEqual(names, [...names].sort(), `packages arrived as ${names.join(", ")}`);
});

test("a package with no files on a measured day is a zero, not a hole", () => {
  // A stack column is all-or-nothing, so one null blanks every band that day.
  // A package that simply had no source files yet was measured — the row
  // counted the tree — and sending null for it would erase the whole stack's
  // history the first time a new package appears.
  // The committed fixture, not the live series: a clone has none until `update` has run.
  const plot = plotDoc();
  const days = plot.days;
  for (const p of plot.classics.packages) {
    assert.equal(p.points.length, days, `${p.pkg} has a point per day`);
  }
  // Every day that carries a classics reading carries one for every package.
  const holes = plot.classics.packages.flatMap((p) => p.points.filter((x) => x.v == null));
  assert.equal(holes.length, 0, "no package is a hole on a day the classics were measured");
});
