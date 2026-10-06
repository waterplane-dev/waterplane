/**
 * The daemon's half of the repo-health series: what it may spawn, in what
 * order, and what it is allowed to say about a run that did not go well.
 *
 * Every rule here exists because of something that is permanent when it goes
 * wrong. Two concurrent `update`s append duplicate rows to an append-only file
 * forever. An orphaned `git` walk that outlives a timeout writes into that same
 * file after the run that started it was reported. And a subcommand this module
 * must never be able to name is the one that can spend money — the whole value
 * of a free series is that nobody has to wonder whether reading it cost
 * anything, so that one is checked as TEXT and not merely as a type.
 *
 * Driven through `RepoHealthDeps`, so the engine need not be on disk and every
 * exit code can be produced on demand. The one test that spawns for real is the
 * timeout, because a process group is not something a fake can prove.
 *
 * The third seam used to be `fs.existsSync`, back when the only engine a
 * worktree could have was a file inside it. It is now the resolved ENGINE, and
 * the ARGV built from it is handed to the fake `spawn` — which is what makes
 * "the bundled engine is pointed at this worktree with `--root=`, and a repo's
 * own copy is not" a checkable sentence rather than a described one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Small enough that the real-spawn test finishes; the module floors it at 1000.
process.env.WATERPLANE_REPOHEALTH_TIMEOUT_MS = "1200";
const {
  REPOHEALTH_TIMEOUT_MS, canReadRepoHealth, readRepoHealth, refreshRepoHealth,
  repoHealthArgv, resolveRepoHealthEngine,
} = await import("../dist/repohealth.js");
// The scope list is its own module for the reason the series files are their
// own files: what a repo measures separately is stored beside what it measured.
const { MAX_SCOPES, cleanScope, readScopes, writeScopes } = await import("../dist/repohealthscopes.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src", "repohealth.ts");

/**
 * A `status` line shaped like the engine's own, so the view carries a series —
 * and, since `--root=`, what the ENGINE says about the tree beside it.
 *
 * Those five are additive and separately optional on the wire, which is the
 * whole reason they are here in full: a repo whose own copy of the tool
 * predates them prints none of them, and `an older copy says none of that`
 * below is the other half of the pair.
 */
const STATUS = JSON.stringify({
  preregVersion: "2026-09-21c", rows: 158, days: 22, staleRows: 0,
  versions: [{ version: "2026-09-21c", rows: 158 }],
  lastSha: "b".repeat(40), lastDay: "2026-09-21", lastTs: 1789996218,
  head: { sha: "c".repeat(40), ts: 1789996658 }, behind: 1,
  commits: 176,
  engineVersion: "2026-09-21e+c27d320f",
  packs: [{ name: "common", version: "1", files: 0 }, { name: "typescript", version: "1", files: 645 }],
  groups: ["packages/host", "packages/shared"],
  recut: "rm /wt/.myapp/repohealth.jsonl && node /desktop/myapp/tools/repohealth.mjs update --root=/wt",
}) + "\n";

/**
 * A `plot` line shaped like the tool's own: points, and beside them the TOOL'S
 * reading of them — the rank, its slope, how many points it was taken over, the
 * day its window starts, and the sentence under the series.
 *
 * Written out here rather than derived, because what this file pins is that the
 * host CARRIES the reading rather than computing one: a fixture the host could
 * have produced itself would pass against exactly the host this rule forbids.
 */
const PLOT = JSON.stringify({
  preregVersion: "2026-09-21c",
  // Shipped by the tool, never defaulted here: what a rank was taken over, and
  // the shortest history that gets one at all.
  windowReadings: 60,
  minReadings: 14,
  days: 3,
  series: [
    {
      key: "size.p95",
      label: "p95 file length",
      unit: "lines",
      points: [
        { day: "2026-09-19", sha7: "aaaaaaa", v: 112 },
        { day: "2026-09-20", sha7: "bbbbbbb", v: 118 },
        { day: "2026-09-21", sha7: "ccccccc", v: 121 },
      ],
      last: 121,
      reading: { rank: 0.92, slope: "rising", n: 22, from: "2026-08-30" },
      detail: "121 lines across 325 files.",
    },
  ],
  context: { areas: { host: { expected: 1200, ceiling: 4000, p90: 2400, commits: 41, subs: 5 } } },
  classics: { loc: [], files: [], deps: [], packages: [], tape: null },
}) + "\n";

const ok = (stdout = "", stderr = "") => ({ code: 0, stdout, stderr, timedOut: false });

/** What the tool prints for a step nobody asked a question about. */
const canned = (step) => (step === "status" ? STATUS : step === "plot" ? PLOT : "");

/** This desktop's engine, as resolution would hand it back. */
const BUNDLED = { path: "/desktop/myapp/tools/repohealth.mjs", kind: "bundled" };
/** …and a worktree's own copy, which decides its own root. */
const OWN = (wt) => ({ path: join(wt, "tools", "repohealth.mjs"), kind: "repo" });

/**
 * A recording fake spawn. `answer` maps a step to the process it produces,
 * `engine` is what resolution is made to return, and `argvs` keeps the WHOLE
 * argv of every spawn — which is the only way "and nothing else" is a
 * checkable claim rather than a described one.
 */
function fake(answer = {}, { emit, engine = BUNDLED } = {}) {
  const calls = [];
  const argvs = [];
  return {
    calls,
    argvs,
    deps: {
      engine: typeof engine === "function" ? engine : () => engine,
      spawn: async (wt, step, onStderr, argv) => {
        calls.push(step);
        argvs.push([...argv]);
        if (emit?.[step]) for (const line of emit[step]) onStderr(line);
        return answer[step] ?? ok(canned(step));
      },
    },
  };
}

/** The steps that WRITE — every call that is not one of the two reads. */
const writes = (calls) => calls.filter((c) => c !== "status" && c !== "plot");

/** A worktree whose `tools/repohealth.mjs` is `body`. */
function worktree(body) {
  const wt = mkdtempSync(join(tmpdir(), "waterplane-repohealth-"));
  mkdirSync(join(wt, "tools"), { recursive: true });
  const p = join(wt, "tools", "repohealth.mjs");
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return wt;
}

test("a refresh runs update, then narrate, then html", async () => {
  const f = fake();
  const view = await refreshRepoHealth("/wt/order", f.deps);
  assert.deepEqual(
    writes(f.calls),
    ["update", "narrate", "html"],
    "narrate describes what update appended and html draws it — any other order reports the run before it",
  );
  assert.equal(view.last.ok, true);
  assert.equal(view.last.step, "html", "the step it got to is the LAST one, not the one that failed");
  assert.equal(view.run, null, "`running` is a state, not a history: it is gone the moment the run ends");
  assert.equal(view.series.rows, 158, "the view carries the series the tool just re-read");
  assert.equal(view.behind, 1);
  // Git seconds in, wire milliseconds out — the tool prints `%ct` and every
  // other instant on this wire is `Date.now()`.
  assert.deepEqual(view.head, { sha: "c".repeat(40), ts: 1789996658 * 1000 });
});

test("a read is two reads — status, then plot — and nothing that writes", async () => {
  const f = fake();
  const view = await readRepoHealth("/wt/read", f.deps);
  assert.deepEqual(
    f.calls, ["status", "plot"],
    "opening the sheet asks what the series IS and what it LOOKS LIKE, and starts nothing that could append",
  );
  assert.equal(view.series.rows, 158, "the status still answers, exactly as it did before there was a plot");
  const s = view.plot?.series?.[0];
  assert.equal(s?.key, "size.p95");
  assert.equal(s?.points?.length, 3);
  // The half that is worth a test: the READING arrived, it was not derived
  // here. What a rank means lives once, beside the pre-registered constants
  // and the fixture that re-derives them — a second definition on this side of
  // the wire would agree today and diverge unnoticed.
  assert.equal(s?.reading?.rank, 0.92);
  assert.equal(s?.reading?.slope, "rising");
  assert.equal(s?.reading?.n, 22, "how many readings that rank was taken over — never the configured window");
  assert.equal(s?.reading?.from, "2026-08-30", "and the day the window starts, because n readings are not n days");
  assert.equal(s?.detail, "121 lines across 325 files.");
});

test("a plot that fails is an absent field, not a failed view", async () => {
  for (const code of [1, 2]) {
    // 2 is the tool that has no `plot` subcommand at all — a worktree whose
    // checkout predates it, which is the common case and not a fault.
    const f = fake({ plot: { code, stdout: "", stderr: "unknown command \"plot\"\n", timedOut: false } });
    const view = await readRepoHealth("/wt/noplot", f.deps);   // resolves; never throws
    assert.equal(view.plot, null, `exit ${code} draws nothing, and says so as an absence`);
    assert.equal(view.series.rows, 158, "…while the series answers untouched — one reader failing is not the view failing");
    assert.equal(view.behind, 1);
    assert.equal(view.tool, true);
  }
});

test("a plot that failed says WHY, because one of those reasons no tap can fix", async () => {
  // `plot: null` says a chart could not be drawn. It does not say whether the
  // refresh button would change that, and the sheet's standing sentence
  // promised it would: *refresh it to measure one*. For a repo carrying its
  // own copy of the engine older than the subcommand that is false for ever —
  // a repo that ships the tool is spawned WITH its own copy and WITHOUT
  // `--root=`, so the desktop's newer engine never reads it.
  const two = { plot: { code: 2, stdout: "", stderr: 'unknown command "plot"\n', timedOut: false } };
  const own = await readRepoHealth("/wt/ownold", fake(two, { engine: OWN("/wt/ownold") }).deps);
  assert.equal(own.plot, null);
  assert.equal(own.series.rows, 158, "the series beside it is untouched — that is the whole point of two reads");
  assert.match(own.plotError, /no `plot` subcommand/);
  assert.match(own.plotError, /exited 2/);
  assert.match(own.plotError, /Update the copy in this repo/, "the fix is in the tree, and the sentence says so");
  // It may NAME the refresh — it has to, to say it will not help — but it
  // must never be the sheet's standing remedy, which is what it replaces.
  assert.match(own.plotError, /refreshing runs the same one again/);
  assert.doesNotMatch(own.plotError, /refresh it to measure one/);

  // Same exit, other engine: the reader is sent to the desktop instead.
  const bundled = await readRepoHealth("/wt/deskold", fake(two).deps);
  assert.match(bundled.plotError, /this desktop's bundled engine/);

  // A failure over a repo that HAS a series is a different sentence again,
  // in the classifier's words.
  const failed = await readRepoHealth("/wt/broke", fake({
    plot: { code: 1, stdout: "", stderr: "repohealth: ENOENT\n", timedOut: false },
  }).deps);
  assert.match(failed.plotError, /could not be read/);
  assert.match(failed.plotError, /exited 1/);
  assert.doesNotMatch(failed.plotError, /subcommand/);

  // …and over a repo with NO series it says nothing at all, however the plot
  // exited. This is the ordinary state of most repos on this desktop and the
  // engine reports it as a non-zero exit with its own `run node
  // tools/repohealth.mjs update first` — a relative path that is wrong in
  // every tree the bundled engine measures, and a remedy the sheet already
  // has a correct wording for. The test is the SERIES, not the code.
  const nothing = await readRepoHealth("/wt/unmeasured", fake({
    status: ok("repohealth: no series yet\n"),
    plot: { code: 1, stdout: "", stderr: "repohealth: no series yet — run `node tools/repohealth.mjs update` first\n", timedOut: false },
  }).deps);
  assert.equal(nothing.series, null);
  assert.equal(nothing.plot, null);
  assert.equal(nothing.plotError, null, "nothing measured yet is the series' absence, not the chart's fault");

  // And an engine that ran clean and printed nothing usable says nothing
  // either, so the standing remedy stands.
  const empty = await readRepoHealth("/wt/empty", fake({
    plot: ok("repohealth: no series yet — run `update` first\n"),
  }).deps);
  assert.equal(empty.plot, null);
  assert.equal(empty.plotError, null, "a tool that answered is not a tool that failed");
});

test("a refresh re-reads the plot, and it is the fresh one that comes back", async () => {
  // Four points after the update appended a row, three before it: the sheet
  // that redraws after a refresh must be looking at what was just measured.
  const grown = JSON.parse(PLOT);
  grown.series[0].points.push({ day: "2026-09-22", sha7: "ddddddd", v: 130 });
  grown.series[0].last = 130;
  grown.days = 4;
  const calls = [];
  let updated = false;
  const deps = {
    fs: { existsSync: () => true },
    spawn: async (wt, step) => {
      calls.push(step);
      if (step === "update") {
        updated = true;
        return ok("repohealth: +1 rows (159 total, 23 days), through abc1234 (2026-09-22).\n");
      }
      if (step === "plot") return ok(updated ? JSON.stringify(grown) + "\n" : PLOT);
      return ok(canned(step));
    },
  };
  const before = await readRepoHealth("/wt/fresh", deps);
  const after = await refreshRepoHealth("/wt/fresh", deps);
  assert.equal(before.plot.series[0].points.length, 3);
  assert.equal(after.plot.series[0].points.length, 4, "the answer carries the plot as it is NOW, not as the sheet last saw it");
  assert.deepEqual(
    writes(calls), ["update", "narrate", "html"],
    "and drawing is never part of a write path: a plot that failed cannot be why a series was not appended to",
  );
});

test("every subcommand this module can reach is a read or one of the three steps", async () => {
  const f = fake();
  await readRepoHealth("/wt/closed", f.deps);
  await refreshRepoHealth("/wt/closed", f.deps);
  const seen = [...new Set(f.calls)];
  assert.ok(seen.length > 0, "an empty log would make every assertion below true of a host that ran nothing");
  assert.deepEqual(
    seen.filter((s) => !["status", "plot", "update", "narrate", "html"].includes(s)), [],
    "the set is closed — a new subcommand is a decision, not something a caller can slip in",
  );
  assert.ok(!seen.includes("judge"), "and the one that can spend money is not in it");
});

test("two concurrent refreshes are one run", async () => {
  const f = fake();
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = {
    ...f.deps,
    // Forwarding `argv` and not rebuilding it: a wrapper that dropped it would
    // be testing a spawn seam nothing in the module hands that shape to.
    spawn: async (wt, step, onErr, argv) => { await gate; return f.deps.spawn(wt, step, onErr, argv); },
  };
  const a = refreshRepoHealth("/wt/single", slow);
  const b = refreshRepoHealth("/wt/single", slow);
  release();
  const [va, vb] = await Promise.all([a, b]);
  assert.equal(
    f.calls.filter((c) => c === "update").length, 1,
    "two updates both append() to an append-only JSONL: the duplicate sha rows are permanent",
  );
  assert.equal(va, vb, "the second caller joins the first run rather than starting a second");

  // And the latch is released afterwards — a worktree is not refreshable once.
  await refreshRepoHealth("/wt/single", f.deps);
  assert.equal(f.calls.filter((c) => c === "update").length, 2);
});

test("a refused update is an answer, and narrate never runs", async () => {
  const words =
    "repohealth: refusing to append — the series was measured under a different definition.\n" +
    "  2026-09-21c (current): 158 rows\n" +
    "To re-cut the whole history under the current definition:\n" +
    "  rm .myapp/repohealth.jsonl && node tools/repohealth.mjs update\n";
  const f = fake({ update: { code: 3, stdout: "", stderr: words, timedOut: false } });
  const view = await refreshRepoHealth("/wt/refused", f.deps);   // resolves; never throws
  assert.equal(view.last.ok, false);
  assert.equal(view.last.step, "update");
  assert.equal(view.last.error, null, "a refusal is the tool WORKING; it is never also an error");
  assert.equal(view.last.refused.code, 3);
  assert.ok(!f.calls.includes("narrate"), "narrating a series update just declined to append to dates the reading");
  assert.ok(!f.calls.includes("html"));
  assert.equal(
    view.last.refused.text, words,
    "verbatim — the remedy deletes a file, and a remedy retyped from a paraphrase is a remedy typed wrong",
  );
});

test("a warning on a clean exit is not a failure", async () => {
  const f = fake({
    update: ok(
      "repohealth: +2 rows (160 total, 23 days), through abc1234 (2026-09-21).\n",
      "repohealth: 3 rows ignored — their commits are no longer on first-parent.\n",
    ),
  });
  const view = await refreshRepoHealth("/wt/warn", f.deps);
  assert.equal(view.last.ok, true, "stale rows are a fact about the series, not a failed run");
  assert.equal(view.last.added, 2);
  assert.deepEqual(view.last.warnings, [
    "repohealth: 3 rows ignored — their commits are no longer on first-parent.",
  ]);
});

test("the progress meter becomes the run's note", async () => {
  const f = fake({}, { emit: { update: ["  …25/400 commits\n", "  …50/400 commits\n"] } });
  let seen;
  const watch = { ...f.deps, spawn: async (wt, step, onErr, argv) => {
    const p = await f.deps.spawn(wt, step, onErr, argv);
    // Mid-flight, which is the only moment this is worth anything: a cold
    // backfill prints nothing else for minutes.
    if (step === "update") seen = (await readRepoHealth(wt, f.deps)).run;
    return p;
  } };
  await refreshRepoHealth("/wt/note", watch);
  assert.equal(seen?.state, "running");
  assert.equal(seen?.note, "50/400 commits", "the LAST line is where it got to");
});

test("NO ENGINE ANYWHERE, no spawn — and the sentence is about the desktop", async () => {
  const f = fake({}, { engine: () => null });
  const read = await readRepoHealth("/wt/none", f.deps);
  const ran = await refreshRepoHealth("/wt/none", f.deps);
  assert.equal(read.tool, false);
  assert.equal(ran.tool, false);
  assert.equal(read.engine, null, "and the view says which engine read it: none did");
  assert.equal(read.series, null);
  assert.equal(read.measure, null);
  assert.equal(read.plot, null, "and nothing to draw either — the field is there, absent, on every answer");
  assert.equal(read.behind, null, "no series ⇒ 'could not tell', never 'up to date'");
  assert.deepEqual(f.calls, [], "there is nothing to run it with; asking it anything is a spawn for nothing");
  assert.equal(ran.last, null, "a run that never started is not a run that failed");
  // The absence is EXPLAINED, and it points at this desktop. The old sentence
  // blamed the repo for not carrying a 10k-line file, which after `--root=` is
  // never the reason and always the wrong place to look.
  assert.match(read.readError ?? "", /repo-health engine/);
  assert.match(read.readError ?? "", /desktop|WATERPLANE_REPOHEALTH_ENGINE/);
});

test("a worktree with no tool of its own is read by the BUNDLED engine, with --root=", async () => {
  const f = fake();
  const view = await readRepoHealth("/wt/kotlin", f.deps);
  assert.deepEqual(
    f.argvs,
    [
      [BUNDLED.path, "status", "--root=/wt/kotlin"],
      [BUNDLED.path, "plot", "--root=/wt/kotlin"],
    ],
    "the engine is the desktop's, the root is the worktree VERBATIM, and there is nothing else in the argv",
  );
  assert.deepEqual(view.engine, { kind: "bundled" }, "and the answer says whose engine read it");
  assert.equal(view.tool, true, "`tool` is now 'an engine can read this', and one can");
});

test("a worktree with its OWN tool is spawned without --root=", async () => {
  // A repo carrying the tool is the authority on its own root: it may be a
  // version ahead or behind and may default somewhere deliberate. This is also
  // what keeps waterplane reading itself with the engine it ships.
  const f = fake({}, { engine: OWN });
  const view = await readRepoHealth("/wt/selfhosted", f.deps);
  assert.deepEqual(f.argvs, [
    [join("/wt/selfhosted", "tools", "repohealth.mjs"), "status"],
    [join("/wt/selfhosted", "tools", "repohealth.mjs"), "plot"],
  ]);
  for (const argv of f.argvs) {
    assert.ok(!argv.some((a) => a.startsWith("--root=")),
      `--root= must not be handed to a repo's own copy: ${argv.join(" ")}`);
  }
  assert.deepEqual(view.engine, { kind: "repo" });
});

test("a refresh runs its three steps through the same engine, argv for argv", async () => {
  const f = fake();
  await refreshRepoHealth("/wt/write", f.deps);
  assert.deepEqual(f.argvs.filter((a) => !["status", "plot"].includes(a[1])), [
    [BUNDLED.path, "update", "--root=/wt/write"],
    [BUNDLED.path, "narrate", "--root=/wt/write"],
    [BUNDLED.path, "html", "--root=/wt/write"],
  ], "a write path's argv is the three steps, each pointed at the worktree, and nothing else");
});

test("a failed status is an absence WITH A REASON, and it leaves the rest alone", async () => {
  const f = fake({
    status: { code: 1, stdout: "", stderr: "repohealth: not a git repository: /wt/notgit\n", timedOut: false },
  });
  const view = await readRepoHealth("/wt/notgit", f.deps);
  assert.equal(view.series, null, "still absent, never a series with 0 rows in it");
  assert.equal(view.measure, null);
  assert.equal(view.behind, null);
  // The half this test exists for. `series: null` and silence reads on screen
  // exactly like a repo nobody has measured yet — one wants a tap on refresh,
  // the other wants a person to look at why the tree cannot be read at all.
  assert.match(view.readError ?? "", /not a git repository: \/wt\/notgit/,
    "the engine's own words, not a paraphrase");
  assert.equal(view.tool, true, "an engine IS here; it could not read THIS tree");
  assert.deepEqual(view.engine, { kind: "bundled" });
  assert.equal(view.plot?.series?.[0]?.key, "size.p95",
    "…and the plot read on its own, untouched by the status failing");
});

test("a clean read says nothing went wrong, and carries what the engine said about the tree", async () => {
  const f = fake();
  const view = await readRepoHealth("/wt/measured", f.deps);
  assert.equal(view.readError, null);
  assert.equal(view.measure?.commits, 176, "the size of the job, which 0 rows cannot be read without");
  assert.equal(view.measure?.engineVersion, "2026-09-21e+c27d320f");
  assert.deepEqual(view.measure?.packs?.map((p) => p.name), ["common", "typescript"]);
  assert.deepEqual(view.measure?.groups, ["packages/host", "packages/shared"]);
  assert.match(view.measure?.recut ?? "", /^rm \//, "absolute on both paths — a re-cut deletes a file");
  assert.equal(view.stepTimeoutMs, REPOHEALTH_TIMEOUT_MS, "the cap is the DESKTOP's and rides on every answer");
});

test("an older copy of the tool says none of that, and the view still works", async () => {
  // The whole reason `parseRepoHealthMeasure` is lenient: a repo carrying its
  // own pre-`--root=` copy prints the series half and nothing else, and it
  // must not lose the series over the half it never learned to print.
  const older = JSON.stringify({
    preregVersion: "2026-09-21c", rows: 3, days: 2, staleRows: 0,
    versions: [{ version: "2026-09-21c", rows: 3 }],
    lastSha: "d".repeat(40), lastDay: "2026-09-20", lastTs: 1789900000,
    head: { sha: "e".repeat(40), ts: 1789910000 }, behind: 2,
  }) + "\n";
  const f = fake({ status: ok(older) }, { engine: OWN });
  const view = await readRepoHealth("/wt/oldtool", f.deps);
  assert.equal(view.series?.rows, 3, "the series reads exactly as it always did");
  assert.equal(view.behind, 2);
  assert.equal(view.measure, null, "…and 'it did not say' is null, never five empty answers");
  assert.equal(view.readError, null, "an engine that is merely older did not fail");
});

test("resolution and argv, unfaked: the rule itself", () => {
  // The seam above proves this module OBEYS a resolution; this proves what the
  // resolution IS, on real paths, with no deps in the way.
  const wt = worktree("process.exit(0)\n");
  const own = resolveRepoHealthEngine(wt);
  assert.equal(own?.kind, "repo", "a worktree carrying the tool is read by its own copy");
  assert.equal(own?.path, join(wt, "tools", "repohealth.mjs"));
  assert.deepEqual(repoHealthArgv(own, wt, "status"), [own.path, "status"]);
  assert.equal(canReadRepoHealth(wt), true);

  // A directory with no tool of its own still resolves — to THIS checkout's
  // engine, three hops up from the BUILT module, which is the change: twelve
  // of the thirteen repos on this desktop used to be a dead end.
  const bare = mkdtempSync(join(tmpdir(), "waterplane-repohealth-bare-"));
  const bundled = resolveRepoHealthEngine(bare);
  assert.equal(bundled?.kind, "bundled");
  assert.equal(
    bundled?.path, resolve(HERE, "..", "..", "..", "tools", "repohealth.mjs"),
    "the three hops must land on the repo root from packages/host/dist as well as from src",
  );
  assert.equal(canReadRepoHealth(bare), true, "…so a repo with no copy of the tool is no longer a dead end");
  assert.deepEqual(
    repoHealthArgv(bundled, bare, "update"), [bundled.path, "update", `--root=${bare}`],
    "ONE token, so a parser that predates the flag ignores it instead of reading it as a subcommand",
  );
});

test("a step that overruns takes its whole process group with it", async () => {
  // A tool that starts a grandchild and then never exits — the shape that made
  // the kill matter: `proc.kill()` reaches the direct child only, and the
  // orphaned git walk goes on appending to the series after the run answered.
  const wt = worktree(
    "import { spawn } from 'node:child_process';\n" +
    "import { writeFileSync } from 'node:fs';\n" +
    // The two READS still answer instantly: the refresh re-reads after the
    // step it killed, and a second hang there would hide the first one — and
    // would charge this test the timeout twice over.
    "if (process.argv[2] === 'status' || process.argv[2] === 'plot') { process.stdout.write('{}\\n'); process.exit(0); }\n" +
    "const kid = spawn('sleep', ['30'], { stdio: 'ignore' });\n" +
    "writeFileSync(process.env.WATERPLANE_TEST_PIDFILE, String(kid.pid));\n" +
    "process.stderr.write('  …1/400 commits\\n');\n" +
    "setInterval(() => {}, 1000);\n",
  );
  process.env.WATERPLANE_TEST_PIDFILE = join(wt, "kid.pid");
  const started = Date.now();
  const view = await refreshRepoHealth(wt);
  const took = Date.now() - started;

  assert.ok(took < REPOHEALTH_TIMEOUT_MS + 5_000, `the cap must ANSWER, not wait for the corpse; took ${took}ms`);
  assert.equal(view.last.ok, false);
  assert.equal(view.last.step, "update");
  assert.match(
    view.last.error, /process group was killed/,
    "a run that was CUT must say so — 'it failed' sends the reader looking for a bug in the tool",
  );
  assert.equal(view.series, null, "and a `{}` status is not a series: absent, never a wrong number");
  assert.equal(view.plot, null, "nor is a `{}` plot a plot — each half goes absent on its own");

  const kid = Number(readFileSync(process.env.WATERPLANE_TEST_PIDFILE, "utf8"));
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) {
    try { process.kill(kid, 0); await new Promise((r) => setTimeout(r, 100)); } catch { alive = false; }
  }
  assert.equal(alive, false, `the grandchild (${kid}) outlived the kill — the signal did not reach the group`);
});

test("this module cannot name the one subcommand that spends money", () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|(^|\s)\/\/[^\n]*/g, "");
  assert.doesNotMatch(
    strip(readFileSync(SRC, "utf8")), /judge/i,
    "The repo-health series is git, regex and arithmetic — free, which is why it can be run on a\n" +
    "whim from a phone. Exactly one subcommand of that tool reaches a model, and it is typed by\n" +
    "hand, about one named event, with a confirmation. No argv this daemon can build may contain it.",
  );
  // The same guard on the BUILT output, because a union type is gone by then
  // and the argv is not.
  assert.doesNotMatch(strip(readFileSync(join(HERE, "..", "dist", "repohealth.js"), "utf8")), /judge/i);
});

// ───────────────────────────────────────────────────────────────────────────
// Scopes: one subtree of a repo, read and refreshed on its own.
// ───────────────────────────────────────────────────────────────────────────

/** A `status` line that ECHOES the scope, the way a current engine does. */
const scopedStatus = (scope) => JSON.stringify({
  ...JSON.parse(STATUS), scope, rows: 12, days: 4, commits: 31,
}) + "\n";

test("a scoped read asks the engine for that subtree, one token", () => {
  // One token, like `--root=`: an engine that predates scopes must ignore the
  // flag rather than take a second word as its subcommand.
  const argv = repoHealthArgv(BUNDLED, "/wt", "status", "apps/ba3-web");
  assert.deepEqual(argv, [BUNDLED.path, "status", "--root=/wt", "--scope=apps/ba3-web"]);
  assert.deepEqual(repoHealthArgv(BUNDLED, "/wt", "status"), [BUNDLED.path, "status", "--root=/wt"]);
  // A repo's own copy decides its own root and still takes the scope.
  assert.deepEqual(
    repoHealthArgv(OWN("/wt"), "/wt", "plot", "apps/x"),
    [join("/wt", "tools", "repohealth.mjs"), "plot", "--scope=apps/x"],
  );
});

test("a scoped read carries the scope through to the view, and drops the repo's documents", async () => {
  const f = fake({ status: ok(scopedStatus("apps/ba3-web")) });
  const view = await readRepoHealth("/wt/scoped", f.deps, "apps/ba3-web");
  assert.equal(view.scope, "apps/ba3-web");
  for (const argv of f.argvs) assert.ok(argv.includes("--scope=apps/ba3-web"), argv.join(" "));
  // `narrate` and `html` write ONE file for the repo, so a scoped view must
  // not present either as this subtree's — the engine refuses both anyway.
  assert.equal(view.narrative, null);
  assert.equal(view.page, null);
});

test("an engine that ignores --scope is caught by its own echo, not trusted", async () => {
  // THE failure this check exists for: an older engine does not fail on an
  // unknown flag, it ignores it — so without the echo the daemon would read
  // the WHOLE repo and write it into a subtree's series, under that name, with
  // nothing saying so.
  const f = fake({ status: ok(STATUS) }); // no `scope` key at all
  const view = await readRepoHealth("/wt/oldengine", f.deps, "apps/ba3-web");
  assert.equal(view.series, null, "nothing that engine said about the repo is presented as the subtree's");
  assert.match(view.readError, /predates subtree readings/);
  assert.match(view.readError, /apps\/ba3-web/);
});

test("a scoped refresh measures and stops — it never writes the repo's narrative", async () => {
  const f = fake({ status: ok(scopedStatus("apps/ba3-web")) });
  await refreshRepoHealth("/wt/scopedrun", f.deps, "apps/ba3-web");
  assert.deepEqual(writes(f.calls), ["update"], "narrate and html are the repo's, not a subtree's");
});

test("a scope's run state is its own, so two readings cannot wear each other's", async () => {
  // Keyed by worktree alone, a subtree's refresh would join the repo's promise
  // and file its outcome under the other one's name.
  const f = fake({ status: ok(scopedStatus("apps/x")) });
  await refreshRepoHealth("/wt/keys", f.deps, "apps/x");
  const scoped = await readRepoHealth("/wt/keys", f.deps, "apps/x");
  const whole = await readRepoHealth("/wt/keys", fake().deps, null);
  assert.ok(scoped.last, "the subtree's refresh is recorded against the subtree");
  assert.equal(whole.last, null, "and the repo's reading has no outcome of its own yet");
});

test("a scope must be a directory inside the worktree", () => {
  const wt = mkdtempSync(join(tmpdir(), "waterplane-scopes-"));
  mkdirSync(join(wt, "apps", "web"), { recursive: true });
  writeFileSync(join(wt, "apps", "notes.md"), "x");
  assert.equal(cleanScope(wt, "apps/web"), "apps/web");
  assert.equal(cleanScope(wt, "apps/web/"), "apps/web");
  for (const bad of ["..", "../x", "/etc", "apps/../..", "apps/notes.md", "apps/missing", "", 7, null]) {
    assert.equal(cleanScope(wt, bad), null, `${JSON.stringify(bad)} is not a scope of this worktree`);
  }
  // The repo itself is not one of its own subtrees: that reading already
  // exists and is the one every scope is read against.
  assert.equal(cleanScope(wt, "."), null);
});

test("the stored scope list is what the client must draw, not what it asked for", () => {
  const wt = mkdtempSync(join(tmpdir(), "waterplane-scopes-"));
  mkdirSync(join(wt, "a"), { recursive: true });
  mkdirSync(join(wt, "b"), { recursive: true });
  assert.deepEqual(writeScopes(wt, ["a", "b", "a", "gone", "../x"]), ["a", "b"]);
  assert.deepEqual(readScopes(wt), ["a", "b"]);
  // A cap, not a policy: every scope is a backfill, and a refresh runs them in
  // series.
  const many = Array.from({ length: MAX_SCOPES + 3 }, (_, i) => `d${i}`);
  for (const d of many) mkdirSync(join(wt, d), { recursive: true });
  assert.equal(writeScopes(wt, many).length, MAX_SCOPES);
});
