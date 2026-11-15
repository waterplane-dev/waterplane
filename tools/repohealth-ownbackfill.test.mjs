// tools/repohealth/ownbackfill.mjs: a repo's OWN readings read back over older
// day rows on request (R-metrics-065) — in a scratch worktree that is always
// removed, with each commit's own declaration, absent-not-zero, only the `own`
// field written, idempotent.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OWN_FILE } from "./repohealth/own.mjs";
import { readFileAt } from "./repohealth/git.mjs";
import {
  HEAD_ONLY, NOT_APPROVED, NOT_DECLARED, OWN_BACKFILL_DEFAULT, OWN_BACKFILL_MAX, SCRATCH_PREFIX, scratchOwnerAlive,
  backfillTargets, clampCommits, lacksOwn, runOwnBackfill, spliceOwn, sweepScratch, withScratch,
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
