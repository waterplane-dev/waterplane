// The repo-health series as the phone reaches it — the SEAM between
// `tools/repohealth.mjs` and the daemon, and nothing else.
//
// The tool itself is pinned by `tools/repohealth.test.mjs`, which re-derives
// `fixture.json` under the pre-registered constants and fails when a number
// moves. That test owns the arithmetic. This script owns the wiring, and it
// deliberately NEVER RUNS THE REAL TOOL: a cold backfill of this repo is ~18 s
// of git and blob reads, it is already paid for once in the tool's own test,
// and paying it again here buys a slower suite and not one extra fact. So both
// repos under the scratch root are throwaway, and the one that "has" the tool
// has a STUB the script writes itself — argv-logging, mode-driven, able to
// fail in the exact shapes the real tool fails in.
//
// What that stub makes checkable, in order:
//
//   1. the repo listing says BOTH repos can be read (`hasRepoHealth`), which
//      is the change: that field used to mean "this worktree carries the
//      tool" and was false for twelve of the thirteen repos on this desktop.
//      One engine reads every tree now, so `false` is reserved for a desktop
//      holding no engine at all
//   8. and the one WITHOUT a tool of its own is read by the BUNDLED engine,
//      pointed at it with `--root=<bare>` — writing into `bare` and nothing
//      into `proj`, because a root that leaked would measure the wrong tree
//      and append to the wrong append-only file
//   2. a GET on a repo that has the tool but no series answers
//      `tool: true, series: null` and SPAWNS NOTHING that could write — an
//      open sheet must not be able to start an 18-second backfill by being
//      looked at. Its argv is exactly `status` then `plot`: two READS, both
//      of which print a line and touch nothing
//   2b. a `plot` that FAILS is an absent field and not a failed read. The
//      drawing arrived after the status did, a checkout older than it exits
//      2, and a sheet that showed nothing about a healthy series because the
//      plotting half broke would be the wrong trade every time
//   3. a refresh runs `update` → `narrate` → `html`, in that order, and the
//      answer carries the narrative and the parsed row count
//   4. the refresh path is NOT reachable by GET. It spawns a subprocess and
//      writes two files into `.claude/outbox/`; CLAUDE.md's rule that a
//      side-effecting endpoint is never a GET is what stops a cross-origin
//      `<img src>` from firing it, since such a request carries no `Origin`
//      for `origin.ts` to judge
//   5. a REFUSAL is an answer: HTTP 200, `ok: false`, and the tool's own
//      stderr relayed VERBATIM. The tool ran and said no — it did not fail —
//      and a non-2xx collapses that into the phone's generic error state,
//      losing the one thing the refusal is worth: the remedy line the reader
//      is supposed to run
//   6. SINGLE-FLIGHT per worktree. `<state>/repohealth.jsonl` is append-only;
//      two concurrent `update`s both read the file before either writes and
//      both append a row for the same sha. There is no undo for that — the
//      duplicate is in the history for ever, and every later reading is drawn
//      through it. Two concurrent POSTs must produce ONE `update` and ONE row.
//   7. `judge` NEVER appears in the argv log — of EITHER engine. It is the
//      tool's one paid branch, and the host must be provably unable to reach
//      it. The tool's own test pins that the free path cannot IMPORT the paid
//      one; this pins that the daemon cannot INVOKE it, which is the other
//      half and the half an unattended refresh could break. It now has two
//      argv builders to be true of, and the flag one of them appends is a
//      third thing that could have carried it.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForHost } from "./lib-e2e.mjs";

const PORT = 8892;
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), `${SLUG}-repohealth-`)));
const MODE_FILE = join(ROOT, "stub-mode");
const ARGV_LOG = join(ROOT, "stub-argv.jsonl");

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The refusal, byte for byte as `refuseMixedPrereg` in `tools/repohealth.mjs`
 * writes it.
 *
 * Copied rather than imported on purpose. The point of §5 is that the phone
 * shows the TOOL'S words and not a paraphrase the host composed, and a test
 * that imported the string would pass just as happily against a host that
 * re-derived the text itself. The cost of the copy is that a reworded refusal
 * fails here — which is the correct outcome: somebody has to look at whether
 * the new wording still survives the trip.
 */
const REFUSAL =
  "repohealth: refusing to append — the series was measured under a different definition.\n" +
  "  2026-08-01: 41 rows\n" +
  "  2026-09-21c (current): 3 rows\n" +
  "Appending would put rows measured under two definitions of the same metric\n" +
  "on one plot, and every row would still be individually correct. Recomputing\n" +
  "the old ones silently is the same rewrite with the evidence removed.\n" +
  "To re-cut the whole history under the current definition:\n" +
  `  rm ${STATE}/repohealth.jsonl && node tools/repohealth.mjs update\n`;

/**
 * One sentence that appears in BOTH `narrate`'s stdout and the markdown it
 * writes, so the assertion about "the narrative reached the phone" holds
 * whichever of the two the host reads. Shaped like a real narrated reading —
 * a rank in a trailing window plus a direction — because that reading is
 * defined once, inside the tool, and the whole reason the phone is handed
 * rendered markdown instead of rows is that it must not define it a second time.
 */
const MARKER = "size.loc is at rank 92 of its trailing window and rising — 143,206 lines across 325 files.";

// ── Two repos: one that adopted the tool, one that never did ────────────────
// Both are readable now. The difference is WHICH engine reads them.
const gitIn = (dir, args) =>
  new Promise((r) => spawn("git", args, { cwd: dir, stdio: "ignore" }).on("exit", r));

async function commit(dir, msg) {
  await gitIn(dir, ["add", "-A"]);
  await gitIn(dir, ["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-qm", msg]);
}

async function makeRepo(name) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  await gitIn(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  await commit(dir, "init");
  // Realpath, because `containRepoDir` resolves one (`/var` → `/private/var`
  // on macOS) and every id, cwd and broadcast key downstream is that form.
  return realpathSync(dir);
}

const PROJ = await makeRepo("proj");
const BARE = await makeRepo("bare");

/**
 * The stub engine — written TWICE, because there are two of them now.
 *
 *   - `<proj>/tools/repohealth.mjs`, where a repo's OWN copy lives, because
 *     "is this worktree's own tool the one that ran" is a question about that
 *     path. It is spawned with no `--root=`, and it REFUSES one: a repo
 *     carrying the tool is the authority on its own root, and a host that
 *     handed it a root anyway would be overruling the only thing that copy is
 *     there for.
 *   - `<root>/engine/repohealth.mjs`, outside every worktree, pointed at by
 *     `<ENV>_REPOHEALTH_ENGINE`. That is the bundled desktop engine, and it
 *     REQUIRES `--root=`: it measures a tree it is not in, and without the
 *     flag there is nothing it could honestly measure. Refusing instead of
 *     falling back to `cwd` is what makes "the host passed the root" a fact
 *     rather than a coincidence — `cwd` is the worktree either way, so a stub
 *     that defaulted to it would pass against a host that never sent one.
 *
 * Each invocation logs its OWN `process.argv[1]`, so every assertion below can
 * say WHICH engine ran and not merely that something did.
 *
 * It reads its mode from a FILE on every invocation, so one booted host can be
 * driven through ok / refuse / slow / noplot without a restart, and it appends
 * every invocation to a log — the log is what §2, §3, §5, §6, §7 and §8 are
 * all actually assertions about. The two READS — `status` and `plot` — answer
 * regardless of mode: they are how the host describes a series, and a read
 * that refused would make every other section untestable. `noplot` is the one
 * exception and it breaks only the plot, exiting 2 the way a checkout older
 * than the subcommand does, which is what §2b is about.
 *
 * `update` is honest about the series file: it only appends a row for a sha it
 * does not already hold, and it reads-then-writes with no locking of its own.
 * That is exactly the real tool's shape, and it is what makes §6 a real test —
 * two of these running at once genuinely do produce two rows.
 */
const stubSource = (rootRule) => `#!/usr/bin/env node
// Generated by scripts/e2e-repohealth.mjs. A stand-in, never the real tool.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const STATE = ${JSON.stringify(STATE)};

const LOG = ${JSON.stringify(ARGV_LOG)};
const MODE_FILE = ${JSON.stringify(MODE_FILE)};
const MARKER = ${JSON.stringify(MARKER)};
const REFUSAL = ${JSON.stringify(REFUSAL)};
const PREREG_VERSION = "2026-09-21c";

const ROOT_RULE = ${JSON.stringify(rootRule)};

const argv = process.argv.slice(2);
const cmd = argv.filter((a) => !a.startsWith("--"))[0] ?? "update";
const cwd = process.cwd();
const rootFlag = argv.find((a) => a.startsWith("--root="));
const root = rootFlag ? rootFlag.slice("--root=".length) : cwd;
// The engine's OWN path, so every assertion can name which of the two ran.
appendFileSync(LOG, JSON.stringify({
  cmd, argv, cwd, root, engine: process.argv[1], at: Date.now(),
}) + "\\n");

// The half of the rule that cannot be checked from outside: this engine only
// works the way it is supposed to be called.
if (ROOT_RULE === "require" && !rootFlag) {
  process.stderr.write("bundled engine spawned with no --root= — it is not in the tree it measures\\n");
  process.exit(1);
}
if (ROOT_RULE === "refuse" && rootFlag) {
  process.stderr.write("a repo's own tool was handed " + rootFlag + " — it decides its own root\\n");
  process.exit(1);
}

const mode = existsSync(MODE_FILE) ? readFileSync(MODE_FILE, "utf8").trim() : "ok";
// A SUBTREE, when asked for. The stub honours it exactly as far as this script
// can check: it echoes the scope back on \`status\` (which is how the daemon
// tells a current engine from one that ignored the flag) and it writes to a
// different series file (which is how "the repo's rows did not move" becomes
// an assertion about bytes). \`--scope=\` is deliberately NOT understood in
// mode "oldengine": that is the engine this seam exists to catch.
const scopeFlag = argv.find((a) => a.startsWith("--scope="));
const scope = mode === "oldengine" || !scopeFlag ? null : scopeFlag.slice("--scope=".length);
const SERIES = join(root, STATE, scope ? "repohealth." + scope.split("/").join("-") + ".jsonl" : "repohealth.jsonl");
const MD = join(root, ".claude", "outbox", "repohealth.md");
const HTML = join(root, ".claude", "outbox", "repohealth.html");

const git = (a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const rows = () => (existsSync(SERIES)
  ? readFileSync(SERIES, "utf8").split("\\n").filter(Boolean).map((l) => JSON.parse(l))
  : []);
const put = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const daysOf = (rs) => new Set(rs.map((r) => r.day)).size;
// A synchronous sleep: this process must still be holding the single-flight
// slot when the second POST arrives, and an async timer would let it exit.
const stall = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The one JSON line, field for field as \`status()\` in tools/repohealth.mjs
// prints it. Anything this stub cannot honestly fake is fixed at the value a
// clean single-definition series has: this script is about the SEAM, and a
// mixed or rewritten series is the tool's own test's business.
if (cmd === "status") {
  const rs = rows();
  const last = rs.length ? rs[rs.length - 1] : null;
  const head = git(["rev-parse", "HEAD"]);
  const headTs = Number(git(["show", "-s", "--format=%ct", "HEAD"]));
  const behind = Number(git(last
    ? ["rev-list", "--count", "--first-parent", last.sha + "..HEAD"]
    : ["rev-list", "--count", "--first-parent", "HEAD"]));
  process.stdout.write(JSON.stringify({
    scope,
    preregVersion: PREREG_VERSION,
    rows: rs.length,
    days: daysOf(rs),
    staleRows: 0,
    versions: rs.length ? [{ version: PREREG_VERSION, rows: rs.length }] : [],
    lastSha: last ? last.sha : null,
    lastDay: last ? last.day : null,
    lastTs: last ? last.ts : null,
    head: { sha: head, ts: headTs },
    behind,
  }) + "\\n");
  process.exit(0);
}

// The other read. One line, every point of every tracked series, and beside
// each series the TOOL'S OWN reading of it — rank, slope, how many points that
// rank was taken over, the day the window starts, and the sentence under it.
// Shaped field for field like \`plot()\` in tools/repohealth.mjs, because the
// whole point of the subcommand is that the phone is handed a reading it did
// not compute.
if (cmd === "plot") {
  if (mode === "noplot") {
    // What a worktree whose tool predates the subcommand actually does.
    process.stderr.write("unknown command " + JSON.stringify(cmd) + "\\n");
    process.exit(2);
  }
  const rs = rows();
  const pts = rs.map((r, i) => ({ day: r.day, sha7: r.sha.slice(0, 7), v: 100 + i }));
  process.stdout.write(JSON.stringify({
    preregVersion: PREREG_VERSION,
    // Shipped, never defaulted by the reader: the window a rank was taken in
    // and the shortest history that gets one at all live with the constants.
    windowReadings: 60,
    minReadings: 14,
    days: rs.length,
    series: [{
      key: "size.p95",
      label: "p95 file length",
      unit: "lines",
      points: pts,
      last: pts.length ? pts[pts.length - 1].v : null,
      reading: pts.length
        ? { rank: 0.92, slope: "rising", n: pts.length, from: pts[0].day }
        : { rank: null, slope: null, n: 0, from: null, reason: "not enough history (0 of 14 readings)" },
      detail: MARKER,
    }],
    context: { areas: { host: { expected: 1200, ceiling: 4000, p90: 2400, commits: 41, subs: 5 } } },
    classics: { loc: pts, files: [], deps: [], packages: [], tape: null },
  }) + "\\n");
  process.exit(0);
}

if (mode === "refuse") {
  process.stderr.write(REFUSAL);
  process.exit(3);
}

if (cmd === "update") {
  if (mode === "slow") stall(3000);
  const rs = rows();
  const head = git(["rev-parse", "HEAD"]);
  const day = git(["show", "-s", "--format=%cs", "HEAD"]);
  const ts = Number(git(["show", "-s", "--format=%ct", "HEAD"]));
  const known = rs.some((r) => r.sha === head);
  if (!known) {
    mkdirSync(dirname(SERIES), { recursive: true });
    appendFileSync(SERIES, JSON.stringify({ sha: head, day, ts, prereg: PREREG_VERSION }) + "\\n");
  }
  const all = known ? rs : rs.concat([{ sha: head, day }]);
  if (known) {
    console.log("repohealth: nothing new — " + all.length + " rows, through " + head.slice(0, 7) +
      " (" + day + "), 0 stale rows ignored.");
  } else {
    console.log("repohealth: +1 rows (" + all.length + " total, " + daysOf(all) + " days), through " +
      head.slice(0, 7) + " (" + day + "), 12 blobs read, 0.4s, 0 stale rows ignored.");
  }
} else if (cmd === "narrate") {
  put(MD, "# repo health\\n\\n" + MARKER + "\\n");
  console.log(MARKER);
  console.log("1 new reading(s) across 1 day(s) written to .claude/outbox/repohealth.md");
} else if (cmd === "html") {
  put(HTML, "<!doctype html><title>repohealth</title><p>the four magnitudes</p>\\n");
  console.log("repohealth: 1 day(s) drawn to .claude/outbox/repohealth.html");
} else {
  process.stderr.write("unknown command " + JSON.stringify(cmd) + "\\n");
  process.exit(2);
}
`;

/** The repo's own copy. Committed, because `hasRepoHealth` is asked of HEAD's
 *  tree the same way every other repo fact here is. */
mkdirSync(join(PROJ, "tools"), { recursive: true });
const STUB = join(PROJ, "tools", "repohealth.mjs");
writeFileSync(STUB, stubSource("refuse"));
chmodSync(STUB, 0o755);
await commit(PROJ, "adopt the repo-health tool");

/**
 * The desktop's bundled engine, OUTSIDE every worktree.
 *
 * Under the scratch root but in a directory with no `.git`, so `discoverTargets`
 * never sees it as a repo — an engine that was itself a discovered worktree
 * would let "the bundled engine ran" pass for "some repo's own tool ran".
 */
const ENGINE_DIR = join(ROOT, "engine");
mkdirSync(ENGINE_DIR, { recursive: true });
const BUNDLED = join(ENGINE_DIR, "repohealth.mjs");
writeFileSync(BUNDLED, stubSource("require"));
chmodSync(BUNDLED, 0o755);

const setMode = (m) => writeFileSync(MODE_FILE, m);
setMode("ok");

const log = () => (existsSync(ARGV_LOG)
  ? readFileSync(ARGV_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : []);
/** The subcommands run since `from`, in the order they were run. */
const since = (from) => log().slice(from).map((e) => e.cmd);
/** The whole entries since `from` — which engine, against which root. */
const runs = (from) => log().slice(from);
const engines = (from) => [...new Set(runs(from).map((e) => e.engine))];
const seriesRows = (repo) => {
  const p = join(repo, STATE, "repohealth.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];
};
/** A SUBTREE's series — a different file, which is what makes "the repo's rows
 *  did not move" an assertion about bytes rather than about a count. */
const scopeSeriesRows = (repo, scope) => {
  const p = join(repo, STATE, `repohealth.${scope.split("/").join("-")}.jsonl`);
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];
};

// ── The host ────────────────────────────────────────────────────────────────
const host = spawn("node", ["packages/host/dist/main.js"], {
  env: {
    ...process.env,
    // e2e must never touch the shared tmux server, and the boot doctor must
    // not print into output anything here reads.
    [E.PREFLIGHT]: "0",
    [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
    [E.CONFIG_DIR]: join(ROOT, "config"),
    // The desktop's engine. Named rather than left to the three-hop default,
    // because the default is THIS repo's real 10k-line tool and a suite that
    // ran it would pay a cold backfill of this repo's own history per read.
    [E.REPOHEALTH_ENGINE]: BUNDLED,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
process.on("exit", () => { try { host.kill("SIGKILL"); } catch { /* already gone */ } });

const api = async (path, init) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, init);
  let body = null;
  try { body = await res.json(); } catch { /* not json, and that is a fact too */ }
  return { status: res.status, body };
};
const post = (path, body = {}) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/**
 * The view out of an answer.
 *
 * The brief settles the FIELDS (`tool`, `series`, `behind`, `narrative`, …)
 * and that every answer carries `ok`; it does not settle whether the view is
 * spread into the envelope or nested under `view`. Both are read so a
 * reasonable choice on the host side does not read here as a missing feature —
 * the envelope's `ok` and the fields themselves are asserted either way.
 */
const view = (b) => (b && typeof b.view === "object" && b.view ? b.view : b) ?? {};

await waitForHost(PORT);

// ── §1 which repos even have the tool ───────────────────────────────────────
const listed = (await api("/api/repos")).body?.targets ?? [];
const proj = listed.find((t) => t.repoName === "proj");
const bare = listed.find((t) => t.repoName === "bare");
check(!!proj && !!bare, `both scratch repos were discovered (got ${listed.map((t) => t.repoName).join(", ") || "none"})`);
check(proj?.hasRepoHealth === true, "the listing says the stubbed repo can be read");
// The change this whole brief is about. `hasRepoHealth` used to mean "this
// worktree carries tools/repohealth.mjs", and a repo without one was a dead
// end that told the reader to copy 10k lines into it. It now means "an engine
// can read this worktree", and the desktop's engine can read any of them — so
// a repo with no tool of its own is OFFERED, not hidden.
check(bare?.hasRepoHealth === true,
  `…and says the same of the repo with NO tool of its own, because the desktop's engine reads it (got ${JSON.stringify(bare?.hasRepoHealth)})`);

// ── §2 a look is not a run ──────────────────────────────────────────────────
const beforeLook = log().length;
const look = await api(`/api/repos/${proj?.id}/repohealth`);
check(look.status === 200, `GET repohealth answers 200 (got ${look.status})`);
// Both repo-health routes answer 200 and say in the ENVELOPE whether they
// were able to say anything, so no caller has to read a status code to find
// out — the refresh does this and the read must not be the exception. The GET
// currently returns a bare `RepoHealthView`, which has no `ok` in it.
check(look.body?.ok === true,
  `…and the envelope carries ok, the way the refresh's does (got ${JSON.stringify(look.body?.ok)}) — the read is the same contract as the write`);
check(view(look.body).tool === true, `…tool: true (got ${JSON.stringify(view(look.body).tool)})`);
// Gated on `tool`, so this cannot pass vacuously against a body that has no
// view in it at all — an absent field and a measured-nothing are not the same
// answer, and only one of them is the one being pinned.
check(view(look.body).tool === true && view(look.body).series == null,
  `…series: null, because nothing has been measured yet (got ${JSON.stringify(view(look.body).series)})`);
check(!since(beforeLook).includes("update"),
  `…and it spawned no update — an open sheet must not start a backfill (ran: ${since(beforeLook).join(", ") || "nothing"})`);
// Exactly the two reads, in that order, and nothing else. Stated as the whole
// argv rather than as "no update": a third subcommand on the read path is the
// thing that would make a look expensive, and "it did not run update" is true
// of every one of them.
check(JSON.stringify(since(beforeLook)) === JSON.stringify(["status", "plot"]),
  `…and its argv was exactly status → plot, the two reads (ran: ${since(beforeLook).join(" → ") || "nothing"})`);
// …run by the repo's OWN copy, and run without a root. A repo carrying the
// tool is the authority on its own root; the stub exits 1 rather than accept
// one, so this is two assertions and the second is enforced from inside.
check(engines(beforeLook).length === 1 && engines(beforeLook)[0] === STUB,
  `…by the repo's OWN tools/repohealth.mjs (ran: ${engines(beforeLook).join(", ") || "nothing"})`);
check(runs(beforeLook).every((e) => !e.argv.some((a) => a.startsWith("--root="))),
  `…and never handed a --root= (argv: ${JSON.stringify(runs(beforeLook).map((e) => e.argv))})`);

// ── §4 the refresh path is not a GET ────────────────────────────────────────
// Before the real refresh, so "nothing ran" is unambiguous.
const beforeGet = log().length;
const wrongVerb = await api(`/api/repos/${proj?.id}/repohealth/refresh`);
check(wrongVerb.status >= 400,
  `GET on the refresh path is not a route (got ${wrongVerb.status}) — it writes, so origin.ts must never see it without an Origin`);
check(since(beforeGet).length === 0,
  `…and nothing was spawned by asking (ran: ${since(beforeGet).join(", ") || "nothing"})`);

// ── §3 the refresh, and the order of the three subcommands ──────────────────
const beforeRun = log().length;
const ran = await post(`/api/repos/${proj?.id}/repohealth/refresh`);
check(ran.status === 200, `POST refresh answers 200 (got ${ran.status})`);
check(ran.body?.ok === true, `…with ok: true (body: ${JSON.stringify(ran.body).slice(0, 300)})`);
check(view(ran.body).last?.added === 1,
  `…and the summary line was PARSED, not relayed: last.added === 1 (got ${JSON.stringify(view(ran.body).last?.added)})`);
check(typeof view(ran.body).narrative?.text === "string" && view(ran.body).narrative.text.includes(MARKER),
  `…and the narrative the tool wrote came back with it (got ${JSON.stringify(view(ran.body).narrative).slice(0, 160)})`);
// The two reads are filtered out, not asserted against: the refresh answers by
// re-reading the view, so `status` and `plot` tag along after the three writes
// and will again whenever that answer grows. What the order is ABOUT is that
// narrating and drawing happen after the rows they describe, never before —
// and that a read is never one of the steps, so a plot that cannot be produced
// can never be the reason a series was not appended to.
const steps = (from) => since(from).filter((c) => c !== "status" && c !== "plot");
check(JSON.stringify(steps(beforeRun)) === JSON.stringify(["update", "narrate", "html"]),
  `update → narrate → html, in that order (ran: ${since(beforeRun).join(" → ")})`);
check(JSON.stringify(since(beforeRun)) === JSON.stringify(["update", "narrate", "html", "status", "plot"]),
  `…and the whole POST was the three steps plus the re-read that answers it (ran: ${since(beforeRun).join(" → ")})`);
check(existsSync(join(PROJ, ".claude", "outbox", "repohealth.html")),
  "…and the page is in .claude/outbox/repohealth.html, where the gallery reads it");
// The re-read is a re-read: the plot that comes back with the refresh is the
// one measured after the row was appended, not the one the sheet already had.
check(view(ran.body).plot?.series?.[0]?.points?.length === seriesRows(PROJ).length,
  `…and the answer carries the plot as it is NOW (${view(ran.body).plot?.series?.[0]?.points?.length} points, ${seriesRows(PROJ).length} rows)`);

// The read the whole `status` subcommand exists for: a second look now
// describes a series instead of an absence, and still runs nothing that writes.
const afterRun = log().length;
const look2 = await api(`/api/repos/${proj?.id}/repohealth`);
check(view(look2.body).series != null, `a later GET reports the series (got ${JSON.stringify(view(look2.body).series)})`);
check(!since(afterRun).includes("update"), "…still without spawning an update");

// ── §2a the plot, and the reading that came WITH it ─────────────────────────
// The rank, the slope, the window and its first day are the tool's, computed
// beside the pre-registered constants and the fixture that re-derives them.
// A phone that recomputed any of it would agree today and drift the day a
// constant moves, and nothing would say so — so what is pinned is that the
// numbers made the trip, not that they are plausible.
const plotted = view(look2.body).plot;
const s0 = plotted?.series?.[0];
check(!!s0, `…and the GET carries a plot (got ${JSON.stringify(plotted).slice(0, 200)})`);
check(!!s0 && Array.isArray(s0.points) && s0.points.length === seriesRows(PROJ).length,
  `…with one point per measured row (${s0?.points?.length} points, ${seriesRows(PROJ).length} rows)`);
check(!!s0 && s0.reading?.rank === 0.92 && s0.reading?.slope === "rising" && s0.reading?.n === seriesRows(PROJ).length,
  `…and the tool's own reading beside them — rank, slope, n (got ${JSON.stringify(s0?.reading)})`);
check(!!s0 && typeof s0.reading?.from === "string" && s0.reading.from.length > 0,
  `…including the day its window starts (got ${JSON.stringify(s0?.reading?.from)})`);
check(!!s0 && s0.detail === MARKER,
  `…and the tool's detail sentence, not one the host composed (got ${JSON.stringify(s0?.detail).slice(0, 160)})`);

// ── §2b a plot that fails is an absent field, never a failed read ───────────
// Exit 2 is what a checkout older than the subcommand does. The series is the
// answer the sheet cannot do without; the drawing is the half that arrived
// later, and it must be able to go missing on its own.
setMode("noplot");
const beforeBlind = log().length;
const blind = await api(`/api/repos/${proj?.id}/repohealth`);
setMode("ok");
check(blind.status === 200 && blind.body?.ok === true,
  `a GET whose plot failed still answers 200 with ok (got ${blind.status}, ok ${JSON.stringify(blind.body?.ok)})`);
// Gated on the series, so this cannot go green against a host that answered
// nothing at all: an absent plot and an absent body read the same otherwise.
check(view(blind.body).series != null && view(blind.body).plot == null,
  `…with the series intact and plot null (series ${JSON.stringify(view(blind.body).series?.rows)}, plot ${JSON.stringify(view(blind.body).plot)})`);
check(JSON.stringify(since(beforeBlind)) === JSON.stringify(["status", "plot"]),
  `…and it still ran exactly the two reads (ran: ${since(beforeBlind).join(" → ") || "nothing"})`);

// ── §5 a refusal is an answer, not an error ─────────────────────────────────
setMode("refuse");
const beforeRefuse = log().length;
const refused = await post(`/api/repos/${proj?.id}/repohealth/refresh`);
check(refused.status === 200,
  `a refusal is HTTP 200 (got ${refused.status}) — the tool RAN and said no, and a non-2xx loses its remedy text to the generic error state`);
check(refused.body?.ok === false, `…with ok: false (body: ${JSON.stringify(refused.body).slice(0, 300)})`);
const text = view(refused.body).last?.refused?.text ?? "";
check(text.trimEnd() === REFUSAL.trimEnd(),
  `…carrying the tool's stderr VERBATIM, including the rm line the reader is meant to run\n      got: ${JSON.stringify(text).slice(0, 400)}`);
check(since(beforeRefuse).includes("update") && !since(beforeRefuse).includes("narrate"),
  `…and narrate was skipped: exit 3 means nothing new to narrate (ran: ${since(beforeRefuse).join(" → ") || "nothing"})`);
check(seriesRows(PROJ).length === 1, `…and the series is untouched (${seriesRows(PROJ).length} row)`);

// ── §6 single-flight per worktree ───────────────────────────────────────────
// A new commit first, so `update` genuinely has a row to append: the duplicate
// this pins is a duplicate ROW, and against a HEAD already in the file the
// stub would correctly write nothing and the test would prove nothing.
writeFileSync(join(PROJ, "NOTE.md"), "one more commit\n");
await commit(PROJ, "move HEAD so there is a row to append");
setMode("slow");
const beforeRace = log().length;
const both = await Promise.all([
  post(`/api/repos/${proj?.id}/repohealth/refresh`),
  post(`/api/repos/${proj?.id}/repohealth/refresh`),
]);
const updates = since(beforeRace).filter((c) => c === "update").length;
check(updates === 1,
  `two concurrent refreshes ran exactly ONE update (got ${updates}) — the JSONL is append-only and a duplicate row is permanent`);
check(seriesRows(PROJ).length === 2,
  `…and the series grew by exactly one row (${seriesRows(PROJ).length} rows)`);
check(both.every((r) => r.status === 200),
  `…both POSTs still answered 200 (got ${both.map((r) => r.status).join(", ")})`);
console.log(`      (the second POST said: ${JSON.stringify(both[1].body).slice(0, 200)})`);

// ── §8 the repo with NO tool of its own, read by the BUNDLED engine ─────────
//
// The whole point of the change. `bare` never adopted the tool; before
// `--root=` it had no readings at all and the phone showed it a dead end. It
// is now read by the desktop's engine, which is not in that tree and must
// therefore be TOLD which tree it is — and told correctly, because the thing
// it writes is an append-only series and a root that leaked from the last
// repo measured would append `proj`'s history into `bare`'s file for ever.
setMode("ok");
const beforeBare = log().length;
const bareLook = await api(`/api/repos/${bare?.id}/repohealth`);
check(bareLook.status === 200 && bareLook.body?.ok === true,
  `a GET on the repo with no tool of its own answers 200 with ok (got ${bareLook.status}, ok ${JSON.stringify(bareLook.body?.ok)})`);
check(view(bareLook.body).tool === true,
  `…tool: true — an engine CAN read it, which is the sentence that used to be false here (got ${JSON.stringify(view(bareLook.body).tool)})`);
check(view(bareLook.body).engine?.kind === "bundled",
  `…and the view says which engine did it: bundled (got ${JSON.stringify(view(bareLook.body).engine)})`);
check(engines(beforeBare).length === 1 && engines(beforeBare)[0] === BUNDLED,
  `…the spawn was the desktop's engine and nothing in the repo (ran: ${engines(beforeBare).join(", ") || "nothing"})`);
// The flag itself, as ONE token and naming THIS worktree. The stub exits 1
// without it, so a host that forgot it fails here rather than measuring `cwd`
// and looking right.
check(runs(beforeBare).every((e) => e.argv.includes(`--root=${BARE}`)),
  `…with --root=${BARE} on every argv (argv: ${JSON.stringify(runs(beforeBare).map((e) => e.argv))})`);
check(runs(beforeBare).every((e) => e.root === BARE),
  `…and the engine measured that root, not its own tree (roots: ${JSON.stringify([...new Set(runs(beforeBare).map((e) => e.root))])})`);

const projRowsBefore = seriesRows(PROJ).length;
const beforeBareRun = log().length;
const bareRan = await post(`/api/repos/${bare?.id}/repohealth/refresh`);
check(bareRan.status === 200 && bareRan.body?.ok === true,
  `a refresh of it runs and answers ok (body: ${JSON.stringify(bareRan.body).slice(0, 300)})`);
check(JSON.stringify(steps(beforeBareRun)) === JSON.stringify(["update", "narrate", "html"]),
  `…update → narrate → html through the bundled engine (ran: ${since(beforeBareRun).join(" → ")})`);
check(engines(beforeBareRun).length === 1 && engines(beforeBareRun)[0] === BUNDLED,
  `…every step of it the desktop's engine (ran: ${engines(beforeBareRun).join(", ")})`);
// Where the bytes landed is the assertion that a wrong `--root=` could not
// survive: the series and the narrative are `bare`'s, and `proj`'s file did
// not move. An append to the wrong append-only file has no undo.
check(seriesRows(BARE).length === 1, `…and it wrote ONE row into bare's own series (${seriesRows(BARE).length})`);
check(existsSync(join(BARE, ".claude", "outbox", "repohealth.md")),
  "…and the narrative into bare/.claude/outbox/repohealth.md, where the gallery reads it");
check(seriesRows(PROJ).length === projRowsBefore,
  `…and nothing at all into proj (${seriesRows(PROJ).length} rows, was ${projRowsBefore})`);
check(view(bareRan.body).series?.rows === 1 && view(bareRan.body).measure !== undefined,
  `…and the answer describes bare's series (rows ${JSON.stringify(view(bareRan.body).series?.rows)})`);

// ── §9 a SCOPE: one subtree of a repo, read and measured on its own ─────────
//
// The seam is the same one `--root=` opened and one level down: the engine is
// told which part of a tree to measure, and everything it writes follows that.
// What this section pins is the part the daemon owns — the flag reaches every
// spawn, the rows land in the SUBTREE's file and not the repo's, a scoped
// refresh writes no document, and an engine that silently ignored the flag is
// caught rather than believed.
mkdirSync(join(BARE, "app", "src"), { recursive: true });
writeFileSync(join(BARE, "app", "src", "main.js"), "console.log(1)\n");
await commit(BARE, "add a subtree worth measuring on its own");

const scoped = await post(`/api/repos/${bare?.id}/repohealth/scopes`, { scopes: ["app", "nope"] });
check(scoped.status === 200 && JSON.stringify(scoped.body?.scopes) === JSON.stringify(["app"]),
  `the scope list stores what IS a directory and drops what is not (got ${JSON.stringify(scoped.body?.scopes)})`);

const beforeScopeRead = log().length;
const scopeLook = await api(`/api/repos/${bare?.id}/repohealth?scope=app`);
check(view(scopeLook.body).scope === "app",
  `…a scoped GET says which reading it is (got ${JSON.stringify(view(scopeLook.body).scope)})`);
check(runs(beforeScopeRead).every((e) => e.argv.includes("--scope=app")),
  `…and --scope=app reached every spawn, one token (argv: ${JSON.stringify(runs(beforeScopeRead).map((e) => e.argv))})`);
check(JSON.stringify(view(scopeLook.body).scopes) === JSON.stringify(["app"]),
  `…and the view carries the list the picker draws (got ${JSON.stringify(view(scopeLook.body).scopes)})`);

const wholeRowsBefore = seriesRows(BARE).length;
const beforeScopeRun = log().length;
const scopeRan = await post(`/api/repos/${bare?.id}/repohealth/refresh`, { scope: "app" });
check(scopeRan.status === 200 && JSON.stringify(steps(beforeScopeRun)) === JSON.stringify(["update"]),
  `a scoped refresh measures and stops — no narrate, no html (ran: ${since(beforeScopeRun).join(" → ") || "nothing"})`);
check(scopeSeriesRows(BARE, "app").length === 1,
  `…the row landed in the subtree's own series (${scopeSeriesRows(BARE, "app").length})`);
check(seriesRows(BARE).length === wholeRowsBefore,
  `…and the repo's series did not move (${seriesRows(BARE).length} rows, was ${wholeRowsBefore})`);

// An engine that predates scopes IGNORES an unknown flag rather than failing
// on it — so without the echo check the daemon would read the whole repo,
// believe it read the subtree, and write it under that name.
setMode("oldengine");
const oldLook = await api(`/api/repos/${bare?.id}/repohealth?scope=app`);
check(view(oldLook.body).series === null && /predates subtree readings/.test(view(oldLook.body).readError ?? ""),
  `an engine that ignored --scope is caught by its own echo (readError: ${JSON.stringify(view(oldLook.body).readError)})`);
setMode("ok");

const badScope = await api(`/api/repos/${bare?.id}/repohealth?scope=../elsewhere`);
check(badScope.status === 400,
  `a scope outside the worktree is refused, never read as the repo (got ${badScope.status})`);

// ── §7 the paid branch is unreachable from the daemon, by EITHER engine ─────
const everyCmd = log().map((e) => e.cmd);
// `everyCmd.length` is in the condition on purpose: "judge never ran" is true
// of a host that never ran anything, and that is the one way this section
// could go green while pinning nothing.
check(everyCmd.length > 0 && !everyCmd.includes("judge"),
  `judge was never invoked across ${everyCmd.length} spawns — the tool's one paid command must not be reachable from an unattended refresh (ran: ${[...new Set(everyCmd)].join(", ")})`);
// Both argv builders have to be true of it, and the log has to prove both ran
// — a guard that only ever saw one engine is a guard over half the code.
const bothRan = engines(0);
check(bothRan.includes(STUB) && bothRan.includes(BUNDLED),
  `…and both engines were exercised, so the guard covers both argv builders (ran: ${bothRan.join(", ")})`);
// Not just the subcommand: the whole argv of every spawn, since one of the two
// builders appends a flag and a flag is a place a word can hide.
const everyWord = log().flatMap((e) => e.argv);
check(!everyWord.some((w) => /judge/i.test(w)),
  `…and the word appears nowhere in any argv either engine was handed (${everyWord.length} words)`);

host.kill("SIGKILL");
await sleep(500);
rmSync(ROOT, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
