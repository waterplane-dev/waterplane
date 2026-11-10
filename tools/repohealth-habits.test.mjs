/**
 * The git-only readings: `metrics/habits.mjs` and `metrics/workspace.mjs`,
 * their rename-aware line counts (`git.readChurn`), and the plot block that
 * carries them to the phone.
 *
 * Synthetic histories only, except the one throwaway repo that proves a move
 * is not a deletion. No absolute value at this repo's HEAD is asserted — the
 * rule `repohealth.test.mjs` states.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { measureHabits, FIX_SUBJECT } from "./repohealth/metrics/habits.mjs";
import { measureLitter, measureDocsDrift, pathCandidates, workspaceElsewhere } from "./repohealth/metrics/workspace.mjs";
import { PREREG } from "./repohealth/constants.mjs";
import typescript from "./repohealth/packs/typescript.mjs";
import * as git from "./repohealth/git.mjs";
import { scopeHistory } from "./repohealth/scope.mjs";
import { buildPlot } from "./repohealth/plot.mjs";
import { readHabits } from "../packages/shared/dist/repohealthhabits.js";

const DAY = 86400;
const T0 = 1_700_000_000;

const CFG = {
  ...PREREG,
  SRC: {
    exts: [".ts"],
    excludeSuffixes: [".d.ts"],
    excludeDirs: ["node_modules", "dist"],
    testGlobs: typescript.testGlobs,
  },
};
const NO_PACK = { ...CFG, SRC: { ...CFG.SRC, exts: [], testGlobs: [] } };

/**
 * A history from `[daysAfterStart, subject, {path: [add, del]}]`. Touches,
 * churn and the batch flag are derived the way `readHistory` does.
 */
function history(spec, extra = {}) {
  const commits = [];
  const touches = new Map();
  const churn = new Map();
  const batch = new Set();
  spec.forEach(([day, subject, files], i) => {
    const sha = "c" + String(i).padStart(3, "0");
    const paths = Object.keys(files).sort();
    commits.push({ sha, ts: T0 + day * DAY, day: String(day), subject, filesTouched: paths, batch: paths.length >= CFG.BATCH_FILES });
    touches.set(sha, paths);
    churn.set(sha, new Map(paths.map((p) => [p, { add: files[p][0], del: files[p][1] }])));
    if (paths.length >= CFG.BATCH_FILES) batch.add(sha);
  });
  return { commits, touches, churn, batch, ...extra };
}
const snapshot = (files) => ({ files: Object.entries(files).map(([path, loc]) => ({ path, loc })) });
const habitsAt = (h, i, snap = snapshot({}), cfg = CFG) => measureHabits(snap, h, i, cfg);

// ── fix-after-change ───────────────────────────────────────────────────────

test("a fix counts only when a different commit changed its file within the week", () => {
  const h = history([
    [0, "add parser", { "src/a.ts": [50, 0] }],
    [3, "fix parser edge", { "src/a.ts": [2, 1] }], // a.ts changed 3 days earlier: counts
    [20, "fix: unrelated", { "src/b.ts": [1, 1] }], // b.ts untouched before: a fix, not an after-change
    [21, "add thing", { "src/c.ts": [5, 0] }],
  ]);
  const { value } = habitsAt(h, 3);
  assert.deepEqual(value.fix.value, { rate: 1 / 4, commits: 4, fixes: 2, fixesAfter: 1 });
});

test("a fix more than seven days after the change does not count", () => {
  const h = history([
    [0, "add", { "src/a.ts": [10, 0] }],
    [8, "Fix a", { "src/a.ts": [1, 1] }],
  ]);
  assert.equal(habitsAt(h, 1).value.fix.value.fixesAfter, 0);
});

test("a batch commit is evidence for the next fix but never the subject", () => {
  const files = {};
  for (let i = 0; i < CFG.BATCH_FILES; i++) files[`src/f${i}.ts`] = [1, 0];
  const h = history([
    [0, "Wip", files],
    [2, "fix f3", { "src/f3.ts": [1, 1] }],
  ]);
  const { value } = habitsAt(h, 1);
  assert.deepEqual(value.fix.value, { rate: 1, commits: 1, fixes: 1, fixesAfter: 1 });
});

test("a merge is never a subject commit", () => {
  const h = history([
    [0, "add", { "src/a.ts": [10, 0] }],
    [1, "Merge branch 'fix-a'", { "src/a.ts": [3, 3] }],
  ]);
  assert.equal(habitsAt(h, 1).value.fix.value.commits, 1);
});

test("the fix pattern is the one the header states", () => {
  for (const s of ["fix: x", "Fix the thing", "fixes #4", "Revert \"add x\"", "hotfix prod", "fix(web)!: y", "feat: fix thing"]) {
    assert.equal(FIX_SUBJECT.test(s), true, s);
  }
  assert.equal(FIX_SUBJECT.test("feat: add thing"), false);
  assert.equal(FIX_SUBJECT.test("prefix handling"), false);
});

test("no pack means no fix reading and no tests reading, with the reason", () => {
  const h = history([[0, "fix", { "src/a.ts": [1, 1] }]]);
  const v = habitsAt(h, 0, snapshot({}), NO_PACK).value;
  assert.equal(v.fix.value, null);
  assert.match(v.fix.reason, /no active language pack/);
  assert.equal(v.testsWithCode.value, null);
});

// ── deletion, net-negative, size ───────────────────────────────────────────

test("the deletion ratio carries its totals and four weeks, oldest first", () => {
  const h = history([
    [0, "a", { "docs/x.md": [100, 0] }],
    [10, "b", { "docs/x.md": [0, 40] }],
    [27, "c", { "docs/x.md": [20, 10] }],
  ]);
  const { value } = habitsAt(h, 2);
  assert.equal(value.deletion.value.added, 120);
  assert.equal(value.deletion.value.deleted, 50);
  assert.equal(value.deletion.value.ratio, 50 / 120);
  // 27 days back = the oldest week, 17 days back = the second, today = the newest.
  assert.deepEqual(value.deletion.value.weeks, [
    { added: 100, deleted: 0 },
    { added: 0, deleted: 40 },
    { added: 0, deleted: 0 },
    { added: 20, deleted: 10 },
  ]);
});

test("nothing added in the window is an absence, not a ratio of zero", () => {
  const h = history([[0, "rm", { "src/a.ts": [0, 30] }]]);
  const { value } = habitsAt(h, 0);
  assert.equal(value.deletion.value, null);
  assert.match(value.deletion.reason, /nothing to compare/);
});

test("net-negative share and commit size use only non-batch, non-merge commits", () => {
  const h = history([
    [0, "add", { "src/a.ts": [10, 0] }],
    [1, "groom", { "src/a.ts": [1, 9] }],
    [2, "Merge pull request #1", { "src/a.ts": [500, 0] }],
    [3, "tiny", { "src/a.ts": [1, 1] }],
  ]);
  const v = habitsAt(h, 3).value;
  assert.deepEqual(v.netNegative.value, { share: 1 / 3, commits: 3, negative: 1 });
  assert.deepEqual(v.commitSize.value, { p95: 10, median: 10, commits: 3 });
  // ...but the merge's lines are in the deletion totals.
  assert.equal(v.deletion.value.added, 512);
});

test("excluded directories are not counted as lines", () => {
  const h = history([[0, "bundle", { "dist/app.js": [9000, 0], "src/a.ts": [3, 0] }]]);
  assert.equal(habitsAt(h, 0).value.deletion.value.added, 3);
});

// ── tests with code ────────────────────────────────────────────────────────

test("tests-with-code uses the pack's test recognition", () => {
  const h = history([
    [0, "a", { "src/a.ts": [5, 0], "src/a.test.ts": [5, 0] }],
    [1, "b", { "src/b.ts": [5, 0] }],
    [2, "c", { "src/a.test.ts": [1, 1] }], // test-only: not a source commit
    [3, "d", { "README.md": [1, 0] }], // no source: not in the denominator
  ]);
  assert.deepEqual(habitsAt(h, 3).value.testsWithCode.value, { rate: 1 / 2, commits: 2, withTests: 1 });
});

test("a pack with source but no test globs says tests are unrecognised", () => {
  const h = history([[0, "a", { "src/a.ts": [5, 0] }]]);
  const v = habitsAt(h, 0, snapshot({}), { ...CFG, SRC: { ...CFG.SRC, testGlobs: [] } }).value;
  assert.equal(v.testsWithCode.value, null);
  assert.match(v.testsWithCode.reason, /test files/);
});

// ── hotspots ───────────────────────────────────────────────────────────────

test("hotspots rank churn times size, only for files that still exist, as a list", () => {
  const h = history([
    [0, "a", { "src/big.ts": [10, 0], "src/small.ts": [10, 0], "src/gone.ts": [99, 0] }],
    [1, "b", { "src/big.ts": [5, 5], "src/small.ts": [1, 1] }],
  ]);
  const { value } = habitsAt(h, 1, snapshot({ "src/big.ts": 1000, "src/small.ts": 50 }));
  assert.deepEqual(value.hotspots.value.items, [
    { path: "src/big.ts", churn: 20, loc: 1000, score: 20000 },
    { path: "src/small.ts", churn: 12, loc: 50, score: 600 },
  ]);
});

test("hotspots are absent with a reason when the tree has no source", () => {
  const h = history([[0, "a", { "src/a.ts": [1, 0] }]]);
  const v = habitsAt(h, 0, snapshot({})).value;
  assert.equal(v.hotspots.value, null);
  assert.ok(v.hotspots.reason);
});

// ── absence: shallow, no churn ─────────────────────────────────────────────

test("a shallow clone whose first commit is inside the window reads absent", () => {
  const h = history([[0, "boundary", { "src/a.ts": [5000, 0] }], [3, "x", { "src/a.ts": [1, 1] }]], { shallow: true });
  const r = habitsAt(h, 1);
  assert.equal(r.value, null);
  assert.match(r.reason, /shallow clone/);
  // The same history in a whole clone is a real (young) repo and reads.
  assert.ok(habitsAt({ ...h, shallow: false }, 1).value);
});

test("a shallow clone whose first commit is older than the window still reads", () => {
  const h = history([[0, "boundary", { "src/a.ts": [5000, 0] }], [90, "x", { "src/a.ts": [1, 1] }]], { shallow: true });
  assert.ok(habitsAt(h, 1).value);
});

test("a history with no rename-aware counts is absent, not zero", () => {
  const h = history([[0, "a", { "src/a.ts": [1, 0] }]]);
  delete h.churn;
  assert.match(habitsAt(h, 0).reason, /rename-aware/);
});

test("the window ends at the commit being measured: a later commit changes nothing", () => {
  const spec = [[0, "a", { "src/a.ts": [4, 0] }], [1, "fix a", { "src/a.ts": [1, 1] }]];
  const short = habitsAt(history(spec), 1);
  const long = habitsAt(history([...spec, [2, "fix a again", { "src/a.ts": [1, 1] }]]), 1);
  assert.deepEqual(short, long);
});

// ── git: a move is not a deletion ──────────────────────────────────────────

test("renameTarget resolves both numstat rename spellings", () => {
  assert.equal(git.renameTarget("a/b.ts"), "a/b.ts");
  assert.equal(git.renameTarget("x.ts => y.ts"), "y.ts");
  assert.equal(git.renameTarget("src/{old => new}/f.ts"), "src/new/f.ts");
  assert.equal(git.renameTarget("src/{ => sub}/f.ts"), "src/sub/f.ts");
});

test("readChurn counts a pure move as nothing and a shallow flag reads false", () => {
  const repo = mkdtempSync(join(tmpdir(), "habits-"));
  try {
    const run = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString();
    const put = (rel, text) => {
      mkdirSync(dirname(join(repo, rel)), { recursive: true });
      writeFileSync(join(repo, rel), text);
    };
    run("init", "-q");
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join("");
    put("old/a.ts", body);
    run("add", "-A");
    run("commit", "-q", "-m", "add");
    mkdirSync(join(repo, "new"));
    run("mv", "old/a.ts", "new/a.ts");
    run("commit", "-q", "-m", "move");
    const churn = git.readChurn(repo);
    const [addSha, moveSha] = run("rev-list", "--reverse", "HEAD").trim().split("\n");
    assert.deepEqual([...churn.get(addSha)], [["old/a.ts", { add: 40, del: 0 }]]);
    assert.deepEqual([...churn.get(moveSha)], [["new/a.ts", { add: 0, del: 0 }]]);
    assert.equal(git.isShallow(repo), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("scopeHistory re-roots churn and keeps the shallow flag", () => {
  const h = history([[0, "a", { "tools/a.ts": [3, 1], "docs/x.md": [9, 9] }]], { shallow: true });
  const s = scopeHistory(h, "tools", CFG);
  assert.deepEqual([...s.churn.get("c000")], [["a.ts", { add: 3, del: 1 }]]);
  assert.equal(s.shallow, true);
});

// ── workspace ──────────────────────────────────────────────────────────────

test("litter lists tracked binaries and build output, biggest first, and says tracked", () => {
  const entries = [
    { path: "app/release.apk", size: 9000 },
    { path: "data/cache.db", size: 100 },
    { path: "dist/main.js", size: 500 },
    { path: "src/a.ts", size: 10 },
    { path: "build/gen.ts", size: 10 }, // `build` is an ordinary source dir name
    { path: "tests/fixtures/sample.zip", size: 77 }, // on purpose
    { path: ".DS_Store", size: 1 },
  ];
  const { value } = measureLitter(entries, CFG);
  assert.equal(value.scope, "tracked");
  assert.equal(value.count, 4);
  assert.equal(value.bytes, 9601);
  assert.deepEqual(value.items.map((i) => i.path), ["app/release.apk", "dist/main.js", "data/cache.db", ".DS_Store"]);
  assert.deepEqual(value.kinds, { "build output": 1, apk: 1, db: 1, ".DS_Store": 1 });
});

test("a clean tree has a litter reading of zero, not an absence", () => {
  assert.equal(measureLitter([{ path: "src/a.ts", size: 1 }], CFG).value.count, 0);
});

test("path candidates: code spans and links, not fences, urls, globs or bare names", () => {
  const text = [
    "See `packages/web/src/App.tsx` and `src/*.ts` and `npm run x/y`.",
    "Bare `README.md` is ignored; [guide](docs/guide.md#top) and [site](https://a.com/x.md).",
    "```",
    "`src/in-a-fence.ts`",
    "```",
    "Also `github.com/owner/repo` and `dist/out.js` and `lib/` and `a/b.ts:12`.",
  ].join("\n");
  assert.deepEqual(pathCandidates(text).map((c) => c.ref).sort(), ["a/b.ts", "docs/guide.md", "lib/", "packages/web/src/App.tsx"]);
});

test("docs drift counts references that do not resolve, per document, with examples", () => {
  const docs = {
    "README.md": "`src/a.ts` exists, `src/gone.ts` does not, [x](docs/b.md) does, [y](docs/none.md) does not.",
    "docs/b.md": "`src/` is a directory; [up](../README.md) resolves from here.",
    "CHANGELOG.md": "removed `src/old.ts`",
  };
  const paths = ["README.md", "CHANGELOG.md", "docs/b.md", "src/a.ts"];
  const { value } = measureDocsDrift(paths, (p) => docs[p], CFG);
  assert.equal(value.docs, 2, "the changelog is not read");
  assert.equal(value.refs, 6);
  assert.equal(value.broken, 2);
  assert.deepEqual(value.items, [{ path: "README.md", broken: 2, of: 4, missing: ["src/gone.ts", "docs/none.md"] }]);
});

test("docs drift is absent when nothing names a path, and when there is no markdown", () => {
  assert.match(measureDocsDrift(["a.ts"], () => "", CFG).reason, /no markdown/);
  assert.match(measureDocsDrift(["a.md"], () => "words only", CFG).reason, /names a repo path/);
  assert.match(measureDocsDrift(["a.md", "b.md"], () => "", { ...CFG, DOCS_MAX_FILES: 1 }).reason, /past the 1/);
});

// ── the plot block, and its trip over the wire ─────────────────────────────

function plotRow(i, habits, workspace) {
  return { sha: "s" + i, day: `2026-01-0${i + 1}`, ts: T0 + i * DAY, batch: false, prereg: "v", habits, workspace };
}

test("the plot carries series, weeks and lists, and the shared reader keeps every field", () => {
  const h = history([
    [0, "add", { "src/a.ts": [20, 0], "src/a.test.ts": [5, 0] }],
    [1, "fix a", { "src/a.ts": [2, 2] }],
  ]);
  const snap = snapshot({ "src/a.ts": 300 });
  const rows = [
    plotRow(0, habitsAt(h, 0, snap), { value: workspaceElsewhere() }),
    plotRow(1, habitsAt(h, 1, snap), {
      value: {
        litter: measureLitter([{ path: "a.apk", size: 5 }], CFG),
        docsDrift: measureDocsDrift(["r.md"], () => "`src/gone.ts`", CFG),
      },
    }),
  ];
  const doc = buildPlot({ rows, prereg: CFG, preregVersion: "v" });
  const hb = doc.habits;
  assert.deepEqual(hb.series.map((s) => s.key), [
    "habits.fixAfterChange", "habits.deletionRatio", "habits.netNegative", "habits.testsWithCode", "habits.commitSizeP95",
  ]);
  for (const s of hb.series) assert.equal(s.points.length, rows.length, s.key);
  assert.equal(hb.series[0].last, 1 / 2);
  assert.equal(hb.weeks.length, 4);
  assert.equal(hb.hotspots.items[0].path, "src/a.ts");
  assert.equal(hb.litter.count, 1);
  assert.equal(hb.docsDrift.broken, 1);

  const read = readHabits(JSON.parse(JSON.stringify(hb)));
  assert.deepEqual(read, JSON.parse(JSON.stringify(hb)));
});

test("an unread family is an absence with its reason in every part, never a zero", () => {
  const shallow = history([[0, "boundary", { "src/a.ts": [9, 0] }]], { shallow: true });
  const rows = [plotRow(0, habitsAt(shallow, 0), { value: workspaceElsewhere() })];
  const hb = buildPlot({ rows, prereg: CFG, preregVersion: "v" }).habits;
  assert.match(hb.absent, /shallow clone/);
  for (const s of hb.series) {
    assert.equal(s.last, null);
    assert.match(s.absent, /shallow clone/);
  }
  assert.match(hb.hotspots.absent, /shallow clone/);
  assert.equal(hb.litter.absent, "read at the newest commit only");
  assert.deepEqual(readHabits(JSON.parse(JSON.stringify(hb))), JSON.parse(JSON.stringify(hb)));
});

test("a malformed habits block is dropped whole by the shared reader", () => {
  assert.equal(readHabits({ windowDays: 28, series: [{ key: "k" }] }), null);
  assert.equal(readHabits(undefined), null);
});
