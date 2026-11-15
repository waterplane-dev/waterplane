// tools/repohealth/ownbackfill.mjs: a repo's OWN readings read back over older
// day rows on request (R-metrics-065) — in a scratch worktree that is always
// removed, with each commit's own declaration, absent-not-zero, only the `own`
// field written, idempotent.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OWN_FILE } from "./repohealth/own.mjs";
import { readFileAt } from "./repohealth/git.mjs";
import {
  HEAD_ONLY, NOT_APPROVED, NOT_DECLARED, OWN_BACKFILL_DEFAULT, OWN_BACKFILL_MAX, SCRATCH_PREFIX, scratchOwnerAlive,
  approvedScratch, backfillTargets, clampCommits, failedOwnReading, lacksOwn, linkNodeModules, mergeRetried, retryableDay, retryTargets,
  runOwnBackfill, spliceOwn, sweepScratch, unlinkNodeModules, withScratch,
} from "./repohealth/ownbackfill.mjs";

const ENGINE = fileURLToPath(new URL("./repohealth.mjs", import.meta.url));
const node = process.execPath;

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "wp-ownbf-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
function git(dir, args, date) {
  const env = date ? { ...cleanEnv(), GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : cleanEnv();
  return execFileSync("git", ["-c", "user.email=e@e", "-c", "user.name=e", ...args], { cwd: dir, encoding: "utf8", env });
}
const engine = (root, ...args) => spawnSync(node, [ENGINE, ...args, `--root=${root}`], { encoding: "utf8", env: cleanEnv() });
// Only THIS test repo's scratch worktrees: another process's own dirs in tmpdir are none of ours.
const scratchLeft = (root) => git(root, ["worktree", "list", "--porcelain"]).split("\n")
  .filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9).trim())
  .filter((p) => p.split("/").pop().startsWith(SCRATCH_PREFIX) && existsSync(p));

test("the count is clamped: junk is the default, never 0, and never past the cap", () => {
  assert.equal(clampCommits(undefined), OWN_BACKFILL_DEFAULT);
  assert.equal(clampCommits("0"), OWN_BACKFILL_DEFAULT);
  assert.equal(clampCommits("nope"), OWN_BACKFILL_DEFAULT);
  assert.equal(clampCommits("7.9"), 7);
  assert.equal(clampCommits(10_000), OWN_BACKFILL_MAX);
});

test("targets: day rows without measured own readings, newest first, HEAD excluded", () => {
  const rows = [
    { sha: "a" }, { sha: "b", own: { readings: [] } }, { sha: "c", own: { notRun: "x", gates: [] } }, { sha: "d" }, { sha: "h" },
  ];
  assert.equal(lacksOwn(rows[1]), false);
  assert.equal(lacksOwn(rows[2]), true, "an unapproved row measured nothing");
  const { picked, left } = backfillTargets(rows, "h", 2);
  assert.deepEqual(picked.map((r) => r.sha), ["d", "c"]);
  assert.equal(left, 3);
});

test("spliceOwn replaces only `own`, only on the last line for that sha", () => {
  const a = { sha: "a", day: "2026-01-01", size: { value: 1 } };
  const text = [JSON.stringify(a), JSON.stringify({ sha: "b", day: "x" }), JSON.stringify({ ...a, size: { value: 2 } }), ""].join("\n");
  const out = spliceOwn(text, new Map([["a", { file: OWN_FILE, readings: [] }]])).split("\n");
  assert.equal(out[0], text.split("\n")[0], "the earlier line for the same sha is untouched");
  assert.equal(out[1], text.split("\n")[1]);
  const row = JSON.parse(out[2]);
  assert.deepEqual(row.size, { value: 2 });
  assert.deepEqual(row.own, { file: OWN_FILE, readings: [] });
  assert.equal(out[3], "", "the trailing newline survives");
});

/** Four days: no declaration; declared `three` (+ a HEAD-only one); `three`'s command changed; HEAD adds `fails`. */
function fixture(t) {
  const root = tmp(t);
  git(root, ["init", "-q", "-b", "main"]);
  writeFileSync(join(root, "a.js"), "export const a = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "one"], "2026-01-01T12:00:00Z");
  mkdirSync(join(root, ".waterplane-shared"));
  writeFileSync(join(root, "count.mjs"), "console.log(2);\n");
  const machine = { key: "machine", name: "Machine", means: "This desktop.", better: "lower", run: ["node", "-e", "console.log(9)"], backfill: false };
  const three = { key: "three", name: "Three", means: "Counts.", better: "higher", unit: "x", run: ["node", "count.mjs"] };
  writeFileSync(join(root, OWN_FILE), JSON.stringify({ readings: [three, machine] }));
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "two"], "2026-01-02T12:00:00Z");
  writeFileSync(join(root, OWN_FILE), JSON.stringify({ readings: [{ ...three, run: ["node", "count.mjs", "--old"] }, machine] }));
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "three"], "2026-01-03T12:00:00Z");
  writeFileSync(join(root, "count.mjs"), "console.log(5);\n");
  const fails = { key: "fails", name: "Fails", means: "Exits 1.", better: "lower", run: ["node", "-e", "process.exit(1)"] };
  writeFileSync(join(root, OWN_FILE), JSON.stringify({ readings: [three, machine, fails] }));
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "four"], "2026-01-04T12:00:00Z");
  return root;
}

test("own-backfill reads older days back with each commit's declaration, absent-not-zero, and removes its worktree", (t) => {
  const root = fixture(t);
  const before = scratchLeft(root);
  assert.equal(engine(root, "update").status, 0);
  const series = join(root, ".waterplane", "repohealth.jsonl");
  const read = () => readFileSync(series, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const orig = read();
  assert.equal(orig.length, 4);
  assert.equal(orig[2].own, undefined, "update reads own at HEAD only");

  const r = engine(root, "own-backfill", "--commits=20");
  assert.equal(r.status, 0, r.stderr);
  const { ownBackfill } = JSON.parse(r.stdout);
  assert.equal(ownBackfill.read, 3);
  assert.equal(ownBackfill.left, 0);
  assert.match(r.stderr, /… 0\/3 commits/, "progress in the daemon's format");

  const rows = read();
  assert.equal(rows.length, 4, "rewritten in place, never appended");
  for (const [i, row] of rows.entries()) {
    const { own: _a, ...rest } = row;
    const { own: _b, ...was } = orig[i];
    assert.deepEqual(rest, was, `row ${i}: every field but own is the row as it was`);
  }
  const val = (row, key) => row.own.readings.find((x) => x.key === key);
  // Day 1: nothing declared — HEAD's keys absent with the reason, never 0, and no gate invented.
  assert.equal(rows[0].own.backfilled, true);
  assert.deepEqual(rows[0].own.readings.map((x) => [x.key, x.value, x.reason]), [
    ["three", null, NOT_DECLARED], ["machine", null, NOT_DECLARED], ["fails", null, NOT_DECLARED],
  ]);
  // Day 2: the approved command, run in that commit's tree (count.mjs printed 2 then).
  assert.equal(val(rows[1], "three").value, 2);
  assert.equal(val(rows[1], "machine").value, null);
  assert.equal(val(rows[1], "machine").reason, HEAD_ONLY);
  assert.equal(val(rows[1], "fails").reason, NOT_DECLARED);
  // Day 3: the command differed from the approved one — not run.
  assert.equal(val(rows[2], "three").value, null);
  assert.equal(val(rows[2], "three").reason, NOT_APPROVED);
  // HEAD untouched by the backfill.
  assert.deepEqual(rows[3].own, orig[3].own);
  assert.equal(val(rows[3], "three").value, 5);

  assert.deepEqual(scratchLeft(root), before, "the scratch worktree is removed");
  assert.equal(git(root, ["worktree", "list"]).trim().split("\n").length, 1, "and git no longer lists it");

  const again = engine(root, "own-backfill");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).ownBackfill.read, 0, "idempotent: a filled row is not read again");
  assert.deepEqual(read(), rows);

  const plot = JSON.parse(engine(root, "plot").stdout);
  const tile = plot.own.series.find((s) => s.key === "three");
  assert.deepEqual(tile.points.map((p) => p.v), [null, 2, null, 5], "the curve has two readings now, and holes stay holes");
});

test("a leftover scratch worktree from a killed run is removed on the next run", (t) => {
  const root = fixture(t);
  const dir = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));
  git(root, ["worktree", "add", "--detach", "--force", dir, "HEAD"]);
  assert.equal(git(root, ["worktree", "list"]).trim().split("\n").length, 2);
  assert.equal(sweepScratch(root), 1);
  assert.equal(existsSync(dir), false);
  assert.equal(git(root, ["worktree", "list"]).trim().split("\n").length, 1);
});

test("the sweep and the run's own removal never prune a worktree record they did not make", (t) => {
  const root = fixture(t);
  // A worktree whose folder this git cannot see (a Windows path under WSL, an unmounted volume):
  // its record names a gitdir that does not exist. A blanket `git worktree prune` would delete it.
  const other = mkdtempSync(join(tmpdir(), "wp-ownbf-other-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  const unseen = join(other, "wt");
  git(root, ["worktree", "add", "--detach", unseen, "HEAD"]);
  const admin = readdirSync(join(root, ".git", "worktrees")).map((n) => join(root, ".git", "worktrees", n))
    .find((d) => readFileSync(join(d, "gitdir"), "utf8").includes("wp-ownbf-other-"));
  assert.ok(admin);
  writeFileSync(join(admin, "gitdir"), "C:/dev/elsewhere/wt/.git\n");
  // Ours: a leftover, then the sweep.
  const dir = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));
  git(root, ["worktree", "add", "--detach", "--force", dir, "HEAD"]);
  assert.equal(sweepScratch(root), 1);
  assert.equal(existsSync(admin), true, "the sweep left the unseen worktree's record alone");
  // And a run (withScratch's own removal) leaves it too.
  assert.equal(withScratch(root, "HEAD", () => 1), 1);
  assert.equal(existsSync(admin), true, "the run's removal left the unseen worktree's record alone");
  assert.equal(scratchLeft(root).length, 0);
});

test("this repo's declared readings that window on today's clock are never back-filled", (t) => {
  const declPath = fileURLToPath(new URL("../.waterplane-shared/health.json", import.meta.url));
  // Private input: the public snapshot omits .waterplane-shared.
  if (!existsSync(declPath)) return t.skip("no .waterplane-shared/health.json in this tree");
  const decl = JSON.parse(readFileSync(declPath, "utf8"));
  const readings = decl.readings ?? decl;
  for (const key of ["capSqueeze", "repairRate"]) {
    const r = readings.find((x) => x.key === key);
    assert.ok(r, key);
    assert.equal(r.backfill, false, `${key} windows on the wall clock; an old commit would store a truncated window`);
  }
});

test("refusals: a scope, unapproved commands, and no series yet — exit 3 with a sentence", (t) => {
  const root = fixture(t);
  const none = engine(root, "own-backfill");
  assert.equal(none.status, 3);
  assert.match(none.stderr, /no series yet/);
  assert.equal(engine(root, "update").status, 0);
  const noOwn = engine(root, "own-backfill", "--no-own");
  assert.equal(noOwn.status, 3);
  assert.match(noOwn.stderr, /not approved/);
  mkdirSync(join(root, "sub"), { recursive: true });
  const scoped = engine(root, "own-backfill", "--scope=sub");
  assert.equal(scoped.status, 3);
  assert.match(scoped.stderr, /whole tree only/);
});

/** Four commits (three old, then HEAD), each declaring `r` (`node r.mjs`), `r.mjs` per `bodies`; `own` per commit (a string overrides the declaration). */
function directFixture(t, bodies, ownTexts = {}) {
  const root = tmp(t);
  git(root, ["init", "-q", "-b", "main"]);
  mkdirSync(join(root, ".waterplane-shared"));
  const decl = JSON.stringify({ readings: [{ key: "r", name: "R", means: "m", better: "lower", run: ["node", "r.mjs"] }] });
  const shas = [];
  for (const [i, body] of bodies.entries()) {
    writeFileSync(join(root, "r.mjs"), body);
    writeFileSync(join(root, OWN_FILE), ownTexts[i] ?? decl);
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", `c${i}`], `2026-01-0${i + 1}T12:00:00Z`);
    shas.push(git(root, ["rev-parse", "HEAD"]).trim());
  }
  const seriesPath = join(root, "series.jsonl");
  writeFileSync(seriesPath, shas.map((sha, i) => JSON.stringify({ sha, day: `2026-01-0${i + 1}` })).join("\n") + "\n");
  const rows = () => readFileSync(seriesPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { root, shas, seriesPath, rows, dayRows: shas.map((sha) => ({ sha })), headSha: shas.at(-1) };
}

test("the budget cuts the run MID-commit: the cut commit is discarded, never written as a failure, and what is left is said", (t) => {
  const f = directFixture(t, ["console.log(1);\n", "console.log(2);\n", "console.log(3);\n", "console.log(4);\n"]);
  let skew = 0;
  const res = runOwnBackfill({
    ...f, git: { readFileAt }, commits: 20, budgetMs: 3_000, now: () => Date.now() + skew,
    // The 2nd commit passes the loop's own check, then the clock jumps: the cut lands inside its readings.
    onProgress: (i, _n, row) => { if (i === 1 && row) skew = 60_000; },
  });
  assert.equal(res.stopped, "budget");
  assert.equal(res.read, 1, "the newest old commit was read; the next was cut");
  assert.equal(res.left, 2, "the cut commit and the one after it are left for the next tap");
  const rows = f.rows();
  assert.equal(rows[2].own.readings[0].value, 3);
  assert.equal(rows[1].own, undefined, "a commit the budget cut is not written: a cut is not the reading's failure");
  assert.equal(rows[0].own, undefined);
});

test("a reading that fails at an OLD commit is absent with its reason, and an unreadable declaration there is recorded as refused", (t) => {
  const f = directFixture(
    t,
    ["process.exit(1);\n", "console.log(2);\n", "console.log(3);\n", "console.log(4);\n"],
    { 1: "{ not json" },
  );
  const res = runOwnBackfill({ ...f, git: { readFileAt }, commits: 20, budgetMs: 60_000 });
  assert.equal(res.stopped, null);
  assert.equal(res.read, 3);
  assert.equal(res.left, 0);
  const rows = f.rows();
  assert.equal(rows[2].own.readings[0].value, 3);
  assert.equal(rows[0].own.readings[0].value, null, "a failure is a hole, never a 0");
  assert.match(rows[0].own.readings[0].reason, /^exited 1/);
  assert.equal(rows[0].own.backfilled, true);
  assert.match(rows[1].own.refused, /not JSON/, "the commit's unreadable declaration is the row's own refusal");
  assert.equal(rows[1].own.backfilled, true);
  assert.equal(rows[1].own.readings, undefined, "nothing was read at that commit");
  assert.equal(res.absent, 1, "the one failed reading counts as absent; a refused commit has none to count");
  assert.equal(res.values, 1);
});

test("a killed run dies at once, and its scratch worktree goes on the sweep the daemon and the next run make", async (t) => {
  const root = tmp(t);
  git(root, ["init", "-q", "-b", "main"]);
  mkdirSync(join(root, ".waterplane-shared"));
  // Slow only in the scratch worktree, so HEAD's reading on `update` is quick.
  writeFileSync(join(root, "slow.mjs"), `setTimeout(() => console.log(1), process.cwd().includes(${JSON.stringify(SCRATCH_PREFIX)}) ? 20000 : 0);\n`);
  writeFileSync(join(root, OWN_FILE), JSON.stringify({ readings: [{ key: "slow", name: "Slow", means: "m", better: "lower", run: ["node", "slow.mjs"] }] }));
  for (const [i, d] of ["01", "02"].entries()) {
    writeFileSync(join(root, "a.js"), `export const a = ${i};\n`);
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", `c${i}`], `2026-01-${d}T12:00:00Z`);
  }
  assert.equal(engine(root, "update").status, 0);
  const before = scratchLeft(root);
  const { spawn } = await import("node:child_process");
  const child = spawn(node, [ENGINE, "own-backfill", `--root=${root}`], { env: cleanEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } });
  await new Promise((res) => child.stderr.on("data", (d) => { if (/0\/1 commits/.test(String(d))) res(); }));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(scratchLeft(root).length, before.length + 1, "the scratch worktree exists while it runs");
  const t0 = Date.now();
  process.kill(-child.pid, "SIGTERM"); // the GROUP, as the daemon does
  await new Promise((res) => child.on("close", res));
  assert.ok(Date.now() - t0 < 5000, "SIGTERM ends it now, not after the reading");
  assert.equal(git(root, ["worktree", "list"]).trim().split("\n").length, 2, "a kill leaves no finally");
  assert.equal(sweepScratch(root), 1);
  assert.deepEqual(scratchLeft(root), before, "the sweep removes the directory");
  assert.equal(git(root, ["worktree", "list"]).trim().split("\n").length, 1, "and git's record of it");
});

test("a sweep leaves the live scratch of another process alone, and takes a dead or pid-less one", (t) => {
  const root = fixture(t);
  // pid 1 is alive and not us: a live run's scratch for another checkout.
  const live = mkdtempSync(join(tmpdir(), `${SCRATCH_PREFIX}1-`));
  const dead = mkdtempSync(join(tmpdir(), `${SCRATCH_PREFIX}999999999-`));
  t.after(() => { for (const d of [live, dead]) { try { git(root, ["worktree", "remove", "-f", "-f", d]); } catch { /* gone */ } rmSync(d, { recursive: true, force: true }); } });
  assert.equal(scratchOwnerAlive(live.split("/").pop()), true);
  assert.equal(scratchOwnerAlive(dead.split("/").pop()), false);
  assert.equal(scratchOwnerAlive(`${SCRATCH_PREFIX}abc`), false, "no pid: a leftover");
  git(root, ["worktree", "add", "--detach", "--force", live, "HEAD"]);
  git(root, ["worktree", "add", "--detach", "--force", dead, "HEAD"]);
  assert.equal(sweepScratch(root), 1);
  assert.equal(existsSync(live), true, "the live run's scratch stays");
  assert.equal(existsSync(dead), false);
});

// ── R-metrics-065: the scratch copy's node_modules link + prepare, and the retry mode ──────────────

const SCRATCH = { linkNodeModules: true, prepare: ["node", "prep.mjs"] };
/**
 * Three days whose reading needs what a bare checkout lacks: `node_modules/dep` (a third-party package, 100),
 * `node_modules/@ws/pk` (a WORKSPACE package -> packages/pk, whose v.txt is the commit's own: 1, 2, 3) and
 * `built.txt` (written by `prep.mjs`, 1000). `scratch` is in the working tree's declaration only.
 */
function scratchFixture(t, { scratch = SCRATCH, prep = "import {writeFileSync} from 'node:fs'; writeFileSync('built.txt','1000');\n" } = {}) {
  const root = tmp(t);
  git(root, ["init", "-q", "-b", "main"]);
  mkdirSync(join(root, ".waterplane-shared"));
  mkdirSync(join(root, "packages", "pk"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), "node_modules\nbuilt.txt\n");
  writeFileSync(join(root, "prep.mjs"), prep);
  writeFileSync(join(root, "r.mjs"),
    "import {readFileSync} from 'node:fs';\nconst n=(f)=>Number(readFileSync(f,'utf8'));\n" +
    "console.log(n('node_modules/dep/v.txt')+n('node_modules/@ws/pk/v.txt')+n('built.txt'));\n");
  const reading = { key: "r", name: "R", means: "m", better: "lower", run: ["node", "r.mjs"] };
  const shas = [];
  for (let i = 1; i <= 3; i++) {
    writeFileSync(join(root, "packages", "pk", "v.txt"), String(i));
    writeFileSync(join(root, OWN_FILE), JSON.stringify({ readings: [reading], ...(i === 3 && scratch ? { scratch } : {}) }));
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", `c${i}`], `2026-01-0${i}T12:00:00Z`);
    shas.push(git(root, ["rev-parse", "HEAD"]).trim());
  }
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "node_modules", "dep", "v.txt"), "100");
  mkdirSync(join(root, "node_modules", "@ws"), { recursive: true });
  symlinkSync("../../packages/pk", join(root, "node_modules", "@ws", "pk"));
  mkdirSync(join(root, "node_modules", ".bin"));
  writeFileSync(join(root, "node_modules", ".bin", "tool"), "x");
  const seriesPath = join(root, "series.jsonl");
  writeFileSync(seriesPath, shas.map((sha, i) => JSON.stringify({ sha, day: `2026-01-0${i + 1}` })).join("\n") + "\n");
  const rows = () => readFileSync(seriesPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { root, shas, seriesPath, rows, dayRows: () => rows(), headSha: shas.at(-1) };
}
const runBf = (f, extra = {}) => runOwnBackfill({ root: f.root, seriesPath: f.seriesPath, dayRows: f.dayRows(), headSha: f.headSha, git: { readFileAt }, commits: 20, budgetMs: 120_000, ...extra });

test("R-metrics-065: scratch is read from the approved working-tree declaration only", () => {
  assert.deepEqual(approvedScratch(JSON.stringify({ readings: [{ key: "a", name: "A", means: "m", better: "lower", run: ["x"] }], scratch: SCRATCH })), SCRATCH);
  assert.equal(approvedScratch(JSON.stringify({ readings: [{ key: "a", name: "A", means: "m", better: "lower", run: ["x"] }] })), null);
  assert.equal(approvedScratch("{ nope"), null);
});

test("R-metrics-065: the link dir is real, third-party entries point at the checkout, workspace packages at the scratch's own copy", (t) => {
  const f = scratchFixture(t);
  const dir = tmp(t);
  mkdirSync(join(dir, "packages", "pk"), { recursive: true });
  assert.equal(linkNodeModules(f.root, dir), null);
  const nm = join(dir, "node_modules");
  assert.equal(lstatSync(nm).isDirectory() && !lstatSync(nm).isSymbolicLink(), true, "a real directory");
  assert.equal(lstatSync(join(nm, "dep")).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(nm, "dep")), join(f.root, "node_modules", "dep"));
  assert.equal(lstatSync(join(nm, "@ws")).isDirectory() && !lstatSync(join(nm, "@ws")).isSymbolicLink(), true, "a scope dir is real too");
  assert.equal(readlinkSync(join(nm, "@ws", "pk")), join(dir, "packages", "pk"), "the workspace package is the scratch's, never today's");
  assert.equal(lstatSync(join(nm, ".bin")).isSymbolicLink(), true);
  assert.match(linkNodeModules(join(dir, "nowhere"), dir), /could not link node_modules/);
});

test("R-metrics-065: removing the scratch never follows a link into the checkout's node_modules", (t) => {
  const f = scratchFixture(t);
  const main = join(f.root, "node_modules");
  const survives = () => {
    assert.equal(readFileSync(join(main, "dep", "v.txt"), "utf8"), "100");
    assert.equal(readFileSync(join(main, ".bin", "tool"), "utf8"), "x");
    assert.equal(readFileSync(join(main, "@ws", "pk", "v.txt"), "utf8"), "3");
    assert.equal(readFileSync(join(f.root, "packages", "pk", "v.txt"), "utf8"), "3");
  };
  // 1. the belt and the plain recursive rm both
  const a = tmp(t);
  linkNodeModules(f.root, a);
  unlinkNodeModules(a);
  assert.equal(existsSync(join(a, "node_modules")), false);
  survives();
  const b = tmp(t);
  linkNodeModules(f.root, b);
  rmSync(b, { recursive: true, force: true });
  survives();
  // 2. through a whole run: checkout, clean, link, readings, worktree removal, between every commit
  const res = runBf(f);
  assert.equal(res.read, 2);
  survives();
  assert.deepEqual(scratchLeft(f.root), []);
  assert.equal(realpathSync(main) !== "", true);
});

test("R-metrics-065: prepare runs before the readings, in the scratch, once per commit; the commit's own workspace code is used", (t) => {
  const f = scratchFixture(t);
  const res = runBf(f);
  assert.equal(res.read, 2);
  const rows = f.rows();
  // 100 (third party, main) + the commit's OWN packages/pk (1 / 2) + 1000 (prepare's built.txt)
  assert.equal(rows[0].own.readings[0].value, 1101);
  assert.equal(rows[1].own.readings[0].value, 1102);
  assert.equal(rows[0].own.prepare, undefined, "a prepare that worked leaves no mark");
  assert.equal(existsSync(join(f.root, "built.txt")), false, "prepare ran in the scratch, never in the live checkout");
});

test("R-metrics-065: a failing prepare is recorded on the day, and the readings keep their own reasons", (t) => {
  const f = scratchFixture(t, { prep: "process.exit(7);\n" });
  const res = runBf(f);
  assert.equal(res.read, 2);
  const own = f.rows()[0].own;
  assert.match(own.prepare, /^prepare \(node prep\.mjs\) exited 7/);
  assert.equal(own.readings[0].value, null);
  assert.match(own.readings[0].reason, /^exited 1/, "the reading's own reason, not the prepare's");
});

test("R-metrics-065: scratch not in the approved working tree means no link and no prepare", (t) => {
  const f = scratchFixture(t, { scratch: null });
  const res = runBf(f);
  assert.equal(res.read, 2);
  const own = f.rows()[0].own;
  assert.equal(own.prepare, undefined);
  assert.match(own.readings[0].reason, /^exited 1/, "no node_modules, no built.txt");
  assert.equal(res.values, 0);
});

test("R-metrics-065 retry: failedOwnReading and retryableDay name run failures only", () => {
  const f = (reason, value = null) => ({ key: "k", value, ...(reason ? { reason } : {}) });
  for (const r of ["exited 1: x", "did not finish within 30 s and was stopped", "could not start node: no such program on PATH", "printed more than 64 KB"]) {
    assert.equal(failedOwnReading(f(r)), true, r);
  }
  for (const r of [NOT_DECLARED, HEAD_ONLY, NOT_APPROVED, "not run — past the first 12 readings a repo may declare", "printed nothing"]) {
    assert.equal(failedOwnReading(f(r)), false, r);
  }
  assert.equal(failedOwnReading(f("exited 1", 3)), false, "a number is never a failure");
  assert.equal(retryableDay({ own: { readings: [f(NOT_DECLARED), f("exited 1")] } }), true);
  assert.equal(retryableDay({ own: { readings: [f(NOT_DECLARED)] } }), false);
  assert.equal(retryableDay({ own: { notRun: "x", readings: [f("exited 1")] } }), false);
  assert.equal(retryableDay({ own: { refused: "x" } }), false);
  assert.equal(retryableDay({ sha: "a" }), false);
});

test("R-metrics-065 retry: the merge keeps an old number a failure would lose, takes a new one, and a retried day goes last", () => {
  const old = { readings: [{ key: "a", value: 5 }, { key: "b", value: null, reason: "exited 1" }, { key: "c", value: 7 }], backfilled: true };
  const fresh = { file: "f", readings: [{ key: "a", value: null, reason: "exited 1" }, { key: "b", value: 9 }, { key: "d", value: null, reason: NOT_DECLARED }] };
  const m = mergeRetried(old, fresh);
  assert.deepEqual(m.readings.map((r) => [r.key, r.value]), [["a", 5], ["b", 9], ["d", null], ["c", 7]]);
  assert.equal(m.retried, true);
  // A budget cut never replaces an old failed run: the failure stays retryable.
  const cut = mergeRetried({ readings: [{ key: "k", value: null, reason: "exited 1: x" }] }, { readings: [{ key: "k", value: null, reason: "budget" }] });
  assert.equal(cut.readings[0].reason, "exited 1: x");
  assert.equal(retryableDay({ own: cut }), true);
  // A standing "not run" replaces it: the day leaves the retry set (no endless re-read button).
  for (const reason of [NOT_DECLARED, NOT_APPROVED, HEAD_ONLY]) {
    const m2 = mergeRetried({ readings: [{ key: "k", value: null, reason: "exited 1: x" }] }, { readings: [{ key: "k", value: null, reason }] });
    assert.equal(m2.readings[0].reason, reason);
    assert.equal(retryableDay({ own: m2 }), false, reason);
  }
  assert.equal(mergeRetried({ readings: [{ key: "k", value: null, reason: "exited 1: x" }] }, { readings: [{ key: "k", value: null, reason: "did not finish within 30 s" }] }).readings[0].reason, "did not finish within 30 s", "a new run failure replaces the old one");
  const days = [
    { sha: "a", own: { readings: [{ key: "k", value: null, reason: "exited 1" }], retried: true } },
    { sha: "b", own: { readings: [{ key: "k", value: 1 }] } },
    { sha: "c", own: { readings: [{ key: "k", value: null, reason: "exited 1" }] } },
    { sha: "h", own: { readings: [{ key: "k", value: null, reason: "exited 1" }] } },
  ];
  const { picked, left } = retryTargets(days, "h", 5);
  assert.deepEqual(picked.map((r) => r.sha), ["c", "a"]);
  assert.equal(left, 1);
});

test("R-metrics-065 retry: re-reads only the days with a failed reading, merges, and counts retried", (t) => {
  const f = scratchFixture(t, { scratch: null });
  // First pass without scratch: both older days fail (no built.txt).
  assert.equal(runBf(f).read, 2);
  assert.equal(f.rows()[0].own.readings[0].value, null);
  // Day 2 had a number once (an earlier, successful read) — plant it, and a failure it must keep.
  const planted = f.rows();
  const { reason: _gone, ...held } = planted[1].own.readings[0];
  planted[1].own.readings[0] = { ...held, value: 55 };
  writeFileSync(f.seriesPath, planted.map((r) => JSON.stringify(r)).join("\n") + "\n");
  // Now the working tree declares scratch (what an approval of the new file covers).
  const decl = JSON.parse(readFileSync(join(f.root, OWN_FILE), "utf8"));
  writeFileSync(join(f.root, OWN_FILE), JSON.stringify({ ...decl, scratch: SCRATCH }));
  const res = runBf(f, { retry: true });
  assert.equal(res.retried, 1, "only the day that failed is re-read; the day holding a number is not");
  assert.equal(res.read, 1);
  assert.equal(res.values, 1);
  const rows = f.rows();
  assert.equal(rows[0].own.readings[0].value, 1101, "a key that failed and now has a number takes it");
  assert.equal(rows[0].own.retried, true);
  assert.equal(rows[1].own.readings[0].value, 55, "a day without a failed reading is left as it was");
  assert.equal(rows[1].own.retried, undefined);
  assert.equal(runBf(f, { retry: true }).retried, 0, "nothing left that failed");
  // A retry counts what it changed: numbers carried over from the old entry are not new.
  const again = f.rows();
  again[0].own = { ...again[0].own, retried: undefined, readings: [{ key: again[0].own.readings[0].key, value: null, reason: "exited 1: x" }, { key: "kept", value: 3 }] };
  writeFileSync(f.seriesPath, again.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const third = runBf(f, { retry: true });
  assert.equal(third.retried, 1);
  assert.equal(third.values, 1, "the key that now reads counts; the old number (3) it carried over does not");
});
