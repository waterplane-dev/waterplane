/**
 * The repo-health series, as something the phone can ask for — and nothing else.
 *
 * `tools/repohealth.mjs` reconstructs a codebase's own history out of git: size,
 * retouch, escape hatches, duplication, dead exports, co-change, context weight,
 * untested modules, the classics. Every number in it is git, regex and
 * arithmetic, which is the whole point of the tool — the series is FREE, and a
 * person can therefore run it as often as they like without deciding whether
 * today's reading is worth paying for. This module is the daemon's half of a
 * button that says "read it to me", and its entire job is to keep that promise
 * while running a subprocess on somebody's behalf.
 *
 * ── Why the host learns nothing about the metrics ──────────────────────────
 *
 * Which rows count, which shas went stale, which pre-registration version a row
 * was measured under — all of that lives in `tools/repohealth/series.mjs`, next
 * to the constants it was measured with and the fixture that pins them. A second
 * copy here would be a second definition of the series: it would agree on the day
 * it was written and disagree silently afterwards, which is the exact failure
 * `constants.mjs` and `fixture.json` exist to make loud. So the host asks the
 * tool — `status`, one JSON line — and re-implements nothing.
 *
 * Nor does it `import()` the tool into this process. A dynamic import of repo
 * code into the daemon cannot be timed out, cannot be killed, and shares a heap
 * with every live PTY; a subprocess can be all three. The tool is spawned, its
 * words are relayed, and the daemon keeps none of its logic.
 *
 * ── Two reads, because a status and a plot are different questions ────────
 *
 * `status` says what the series IS — how much history, under which definition,
 * through which commit. `plot` says what it LOOKS like: the points, and beside
 * every one of them the tool's own reading of that series (rank, slope, how
 * many points that rank was taken over, the day the window starts, and the
 * reason when there is no rank). Both are reads of the same file and both cost
 * about fifty milliseconds, and they are kept apart because a phone that cannot
 * draw must still get the status — one subcommand carrying both would make the
 * cheaper answer depend on the more expensive one being understood.
 *
 * A `plot` that fails is therefore an ABSENT FIELD and not a failed view: one
 * reader falling over must not take the other's answer with it. `plot: null`
 * beside a live `series` is the honest shape of "measured, not drawn".
 *
 * The reading crosses the wire already computed. What a rank IS — the window,
 * the minimum number of points, the slope's sign — is defined once in
 * `tools/repohealth/constants.mjs`, beside the frozen constants and the fixture
 * that re-derives them. A second implementation on the phone would sit outside
 * that fixture, so a changed definition would move one plot and not the other,
 * silently. The tool states, the phone draws.
 *
 * ── Why nothing here can spend a token ─────────────────────────────────────
 *
 * Exactly one module of that tool may reach a model, and it is reached only from
 * the CLI branch a person types by hand with a confirmation. The steps this file
 * can ask for are a closed set — `RepoHealthStep` — and `repohealth.test.mjs`
 * asserts as TEXT that the paid subcommand's name appears in no argv this module
 * can build. A guard that is only a convention is not a guard: the whole value of
 * a free series is that nobody has to wonder.
 *
 * ── Single-flight, because the series file is append-only ──────────────────
 *
 * Two concurrent `update`s both `append()` to `.waterplane/repohealth.jsonl` and both
 * write rows for the same shas. The file is append-only by design (a rewritten
 * history is the user's to explain, not the tool's to tidy away), so those
 * duplicate rows are permanent. One promise per worktree; a second caller joins
 * the first rather than starting a second run.
 *
 * ── Why this is not a durable op ───────────────────────────────────────────
 *
 * It types nothing into a session, it writes only the tool's own three files, and
 * it is idempotent by the tool's construction — a second `update` with nothing
 * new appends nothing and says so. There is no ackId and no queue entry, because
 * the thing a queue buys is "delivered exactly once, eventually", and a refresh
 * delivered an hour late measures a tree nobody is looking at any more. The
 * phone asks again instead.
 *
 * ── A refusal is an answer ─────────────────────────────────────────────────
 *
 * Exit 3 is the tool declining to append — a series measured under two
 * definitions of the same metric. It ran, it looked, and it said no, in its own
 * words on stderr. Those words are relayed verbatim and the route still answers
 * 200: collapsing them into an HTTP error would lose the only sentence that says
 * what to do next. Nothing here applies itself either — a refusal is never
 * repaired by deleting the series.
 *
 * ── Which engine, and why a repo's own one wins ────────────────────────────
 *
 * This module used to spawn `join(wt, "tools/repohealth.mjs")` and report
 * `tool: false` when it was not there, which was twelve of the thirteen repos
 * on this desktop: every one of them showed a dead end that told the reader to
 * copy 10k lines into their repo. The engine now takes `--root=<path>` and
 * derives what a repo is written in, so one copy reads every tree. Resolution,
 * per worktree, in this order:
 *
 *  1. **The worktree's own `tools/repohealth.mjs`**, if it is there. Spawned
 *     with argv `[thatPath, step]`, cwd the worktree, and **no `--root=`**. A
 *     repo carrying the tool is the authority on its own root — it may be a
 *     version ahead or behind, it may default somewhere deliberate, and this
 *     is also what keeps waterplane self-hosting and every test written against that
 *     shape green. (The flag was designed as ONE argv token precisely so an
 *     old parser ignores it rather than reading it as a subcommand, so the
 *     omission is not a compatibility crutch — it is who decides.)
 *  2. **The bundled engine** — `WATERPLANE_REPOHEALTH_ENGINE` when set, else this
 *     checkout's own `tools/repohealth.mjs`, three hops up from this module
 *     (the rule `main.ts` uses for `.env` and `webbundle.ts` for the web
 *     bundle, and it holds identically from `src/` under tsx and from `dist/`
 *     after a build, because both sit one level under `packages/host`). Argv
 *     `[enginePath, step, "--root=" + wt]`, cwd the worktree.
 *  3. **Neither** ⇒ no engine, `tool: false`, and a sentence saying THE
 *     DESKTOP has none. The old sentence blamed the repo, which after this
 *     change is never the reason and always the wrong place to look.
 *
 * ── Containment: what `--root=` may be ─────────────────────────────────────
 *
 * "The daemon now runs a script against a directory" is exactly the sentence a
 * reader wants the guard for, so: the worktree reaches this module only
 * through `findTarget(ctx.root, id)` in `api.ts`, which matches an `id`
 * against `discoverTargets(ctx.root)` — directories under `WATERPLANE_ROOT` holding
 * a `.git`, plus the entries their own `git worktree list` reports. **No path
 * in the request is read**: the client sends an id, and the id selects a
 * worktree the host already discovered. `--root=` is that worktree verbatim,
 * and the engine path is a host constant or an env var on this desktop. No
 * shell, a fixed argv, and nothing in `paths.ts` / `containRepoDir` /
 * `scaffold.inRoot` is loosened or bypassed — this module does not widen what
 * a client may name, it widens what the host may run against what the client
 * could already name.
 *
 * Everything else in the header still holds and holds harder: no metric is
 * re-implemented here, the engine is never `import()`ed into this process, the
 * process GROUP is killed on a timeout, there is one promise per worktree, and
 * `RepoHealthStep` stays a closed union with the text assertion in
 * `repohealth.test.mjs` that the one paid subcommand appears in no argv this
 * module can build — including the argv `--root=` now rides in.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { readScopes } from "./repohealthscopes.js";
import {
  REPOHEALTH_HTML,
  REPOHEALTH_MD,
  REPOHEALTH_TOOL,
  classifyExit,
  parseRepoHealthMeasure,
  parseRepoHealthPlot,
  parseRepoHealthProgress,
  parseRepoHealthStatus,
  parseUpdateSummary, secondsToMs, envName } from "@waterplane/shared";
import type { RepoHealthMeasure, RepoHealthOutcome, RepoHealthPlot, RepoHealthRun, RepoHealthSeries, RepoHealthView } from "@waterplane/shared";
import { env } from "./env.js";

/**
 * How long ONE step of the tool may run before its process group is killed.
 *
 * The first `update` on a repo with no series is a backfill: one snapshot per
 * first-parent commit, every blob of every tree read. On THIS repo that is 175
 * first-parent commits in 21.6 s, measured 2026-09-21 by the run that cut
 * `tools/repohealth/fixture.json` — seconds, not minutes. Minutes is true of
 * the FLEET, which is the case this cap is set for now that one engine reads
 * every tree: `~/dev/realestatecalc` is 1,329 first-parent commits, seven and
 * a half times this repo's history, and every run after the first is a handful
 * of commits and finishes in under a second. Three minutes is the cap on the
 * slow case; the fast case never comes near it.
 *
 * Floored at a second rather than at a minute: the floor is there to stop a
 * typo switching the tool off, and a cap nothing can make short is a cap no
 * test can prove reaches the process GROUP — which is the part of this worth
 * pinning (`repohealth.test.mjs`).
 */
export const REPOHEALTH_TIMEOUT_MS = Math.max(1_000, Number(env("REPOHEALTH_TIMEOUT_MS")) || 180_000);

/**
 * The only subcommands this daemon may ask for.
 *
 * A closed union rather than a string, so the paid branch of the CLI is not
 * merely un-called here but unrepresentable. `repohealth.test.mjs` checks the
 * same thing as text, because a type disappears at build time and the guard
 * must not.
 */
export type RepoHealthStep = "status" | "plot" | "update" | "narrate" | "html";

/** The three steps a refresh runs, in order. `status` and `plot` are READS and
 *  neither is one of them: a write path's argv is these three and nothing
 *  else, so a drawing that failed can never be a reason a series was not
 *  appended to. */
const REFRESH_STEPS: readonly RepoHealthStep[] = Object.freeze(["update", "narrate", "html"]);

/** A SCOPE's refresh: measure, and nothing that writes a document. See
 *  `runRefresh` — the engine refuses `narrate` and `html` under a scope
 *  because both write one file for the repo. */
const SCOPED_REFRESH_STEPS: readonly RepoHealthStep[] = Object.freeze(["update"]);

/** How much of the tool's output is kept. A backfill's stderr is a progress
 *  meter, and `html` prints one line; neither is large, and a runaway one is
 *  not worth holding a PTY-pumping process's memory for. */
const MAX_BUFFER = 4 * 1024 * 1024;

/** What one finished spawn said. `timedOut` is not an exit code: the process was
 *  killed, so whatever code arrives is the signal's, not the tool's verdict. */
export interface RepoHealthProc {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Which engine will read a worktree, and whose it is. */
export interface RepoHealthEngine {
  /** Absolute path to the script that gets spawned. */
  path: string;
  /** `repo` = the worktree's own copy, which decides its own root; `bundled` =
   *  this desktop's, pointed at the worktree with `--root=`. */
  kind: "repo" | "bundled";
}

/**
 * The seams a test drives this through: a fake `spawn` (so the engine need not
 * be on disk, and every exit code can be produced on demand), a clock, and the
 * ENGINE RESOLUTION.
 *
 * The third one used to be `fs.existsSync`, which was the whole of resolution
 * when the only engine a worktree could have was its own file. Faking a bare
 * `existsSync` now would decide the wrong question — a test that wants "this
 * repo has no tool of its own" would also be saying the desktop has none —
 * so the seam is the resolved engine itself, and the ARGV built from it is
 * handed to `spawn` so a test can assert exactly what would have run.
 */
export interface RepoHealthDeps {
  spawn?: (
    wt: string,
    step: RepoHealthStep,
    onStderr: (chunk: string) => void,
    argv: readonly string[],
  ) => Promise<RepoHealthProc>;
  now?: () => number;
  engine?: (wt: string) => RepoHealthEngine | null;
}

/**
 * One promise per worktree — see the header. The map is memory-only: a restart
 * loses the fact that a run was in flight, which is correct, because the run
 * died with the process and the tool's own idempotence covers the rest.
 */
const inflight = new Map<string, Promise<RepoHealthView>>();

/** The run in flight per worktree, mutated live so a poll of the read route sees
 *  the progress line the tool is printing right now. Deleted when it ends —
 *  `running` is a state, not a history. */
const running = new Map<string, RepoHealthRun>();

/** How the last refresh ENDED, per worktree. Memory-only for the same reason as
 *  the latch: a restart loses it, and the series on disk is the durable half. */
const lastOutcome = new Map<string, RepoHealthOutcome>();

/**
 * This desktop's own engine: the env override, else this checkout's copy.
 *
 * Read on every call rather than frozen at import. Since `env.ts` (`main.ts`'s
 * first import) loads the `.env` files, a constant would now see them too — but
 * a call-time read also serves a caller that never went through `main.ts`.
 *
 * The three hops are `env.ts`'s rule for `.env` and `webbundle.ts`'s for
 * `packages/web/dist`: `import.meta.dirname` is `packages/host/src` under tsx
 * and `packages/host/dist` after a build, and both are one level under
 * `packages/host`, so the same path reaches the repo root from either.
 *
 * `WATERPLANE_REPOHEALTH_ENGINE` is taken as an ABSOLUTE path and is not repaired: a
 * relative one would resolve against whatever `cwd` the daemon was started in,
 * which on a launchd service is `/`. A value that is not absolute, or names
 * nothing, is no engine — never a quiet fallback to the bundled one, because a
 * desktop that named an engine and typo'd it must not be told its reading came
 * from the engine it asked for.
 */
function bundledEngine(): string | null {
  const named = env("REPOHEALTH_ENGINE");
  if (named) return isAbsolute(named) && existsSync(named) ? named : null;
  const own = resolve(import.meta.dirname, "../../..", REPOHEALTH_TOOL);
  return existsSync(own) ? own : null;
}

/**
 * Which engine reads this worktree — its own copy first, then the desktop's.
 *
 * The order is the header's: a repo carrying the tool is the authority on its
 * own root, and it is also how waterplane keeps reading itself with the engine it
 * ships rather than with a copy of the same file reached by a different path.
 */
export function resolveRepoHealthEngine(wt: string): RepoHealthEngine | null {
  const own = join(wt, REPOHEALTH_TOOL);
  if (existsSync(own)) return { path: own, kind: "repo" };
  const bundled = bundledEngine();
  return bundled ? { path: bundled, kind: "bundled" } : null;
}

/**
 * Can repo-health be read for this worktree at all?
 *
 * Was `hasRepoHealthTool`, and the rename is the change: the question is no
 * longer about a file in the repo. `false` is now a fact about the DESKTOP —
 * one `existsSync` per repo in the listing, plus one for the bundled engine,
 * and still deliberately not a run of anything.
 */
export function canReadRepoHealth(wt: string): boolean {
  return resolveRepoHealthEngine(wt) !== null;
}

/**
 * The argv one step runs as — the whole of it, so there is one place to read
 * what this daemon can spawn.
 *
 * `--root=` is appended for the bundled engine only, and it is the worktree
 * verbatim (see the containment note in the header). One token, never two: a
 * second word would be read as a subcommand by any parser that predates the
 * flag, and exit 2 on it.
 */
export function repoHealthArgv(
  engine: RepoHealthEngine,
  wt: string,
  step: RepoHealthStep,
  /** A subtree to measure as though it were the repo, or null for the repo. */
  scope: string | null = null,
): string[] {
  const argv = engine.kind === "repo" ? [engine.path, step] : [engine.path, step, `--root=${wt}`];
  // One token, like `--root=`, and for the same reason: an engine that
  // predates scopes must IGNORE it rather than read the path as a subcommand.
  // That silence is also the danger — an older engine would measure the whole
  // repo into a subtree's series — which is why `readStatus` compares what it
  // asked for against the scope the engine echoes back.
  if (scope) argv.push(`--scope=${scope}`);
  return argv;
}

/**
 * The key every per-run map is held under.
 *
 * A worktree is no longer one series: the repo has one and each scope has its
 * own, and they are measured by separate spawns that can be in flight at the
 * same time. Keyed by the worktree alone, a scope's refresh would join the
 * repo's promise, report the repo's progress line, and leave its own outcome
 * under the other one's name.
 */
const keyOf = (wt: string, scope: string | null): string => (scope ? `${wt}\u0000${scope}` : wt);

/**
 * Why there is no reading, when there is no engine — and the reason is always
 * about this desktop.
 *
 * Said in full, naming both places that were looked at and the knob that
 * overrides them, because the alternative a reader reaches for is copying the
 * tool into their repo, which is the one thing this change removed the need
 * for.
 */
function noEngineText(): string {
  const named = env("REPOHEALTH_ENGINE");
  if (named) {
    return `No repo-health engine: ${envName("REPOHEALTH_ENGINE")} is set to ${named}, which is not an absolute path ` +
      `to a file that exists. It is taken as said — nothing falls back to the bundled engine behind it.`;
  }
  return `No repo-health engine on this desktop: this worktree has no ${REPOHEALTH_TOOL} of its own and ` +
    `none was found at ${resolve(import.meta.dirname, "../../..", REPOHEALTH_TOOL)}. ` +
    `Point ${envName("REPOHEALTH_ENGINE")} at one to read repos with an engine from elsewhere.`;
}

/**
 * Run one subcommand, and make sure a timeout reaches everything it started.
 *
 * ── Why `spawn` and not `execFile` ─────────────────────────────────────────
 *
 * `execFile` is the obvious choice for "run it and hand me the output", and it
 * cannot do the one thing that matters here: it does NOT forward `detached` to
 * the spawn it performs — node's own types leave the field off
 * `ExecFileOptions`, and its implementation passes a fixed list of options
 * through. A child that is not a group leader cannot be killed as a group, and
 * `update` is a loop over `git` subprocesses. So the buffering is done here,
 * bounded, and the child is its own group.
 *
 * `assess.ts` and `sidecar.ts` argue the group kill out at length; the short
 * version is that an orphan holding the pipe open makes a killed run take as
 * long as the thing it was killed for, and an orphan still WRITING after
 * cleanup corrupts the next run's evidence. Here the evidence is an append-only
 * series file, so an orphaned `update` appending after this promise resolved is
 * a duplicate row nothing can remove.
 *
 * No shell and a fixed argv: `repoHealthArgv` built it out of a resolved
 * engine path (a host constant or this desktop's env var), a member of a
 * closed union, and a worktree `api.ts` selected by id out of
 * `discoverTargets` — no part of it comes from a client. There is nothing here
 * for a shell to interpret and so no shell.
 */
function runStep(
  wt: string,
  // The step is in `argv` already — it stays in the signature because this IS
  // the `RepoHealthDeps.spawn` seam, and a fake that reads it must be looking
  // at the same parameter the real one is handed.
  _step: RepoHealthStep,
  onStderr: (chunk: string) => void,
  argv: readonly string[],
): Promise<RepoHealthProc> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    /** Keep the ENDS. `update`'s answer is its last line and its progress is on
     *  stderr; a backfill that printed more than this is printing a loop. */
    const keep = (s: string, chunk: string): string => {
      const next = s + chunk;
      return next.length > MAX_BUFFER ? next.slice(next.length - MAX_BUFFER) : next;
    };
    // `detached` makes the child a process-group leader, which is the only way
    // a signal can reach what it spawned. It is NOT "run in the background":
    // the pipes are still ours and the child is never `unref`d.
    const child = spawn(process.execPath, [...argv], { cwd: wt, detached: true });
    /** Signal the GROUP. An already-dead group throws ESRCH — the good case. */
    const killGroup = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch { /* already gone, or never started */ }
    };
    const done = (code: number | null, why: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: why + stderr, timedOut });
    };
    /**
     * A timeout ANSWERS; it does not wait to be let go. `close` fires when
     * every pipe is done, which a killed process's own children can hold open,
     * and the caller is a request somebody is looking at.
     */
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 2000).unref?.();
      done(null, "");
    }, REPOHEALTH_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => { if (!settled) stdout = keep(stdout, d); });
    child.stderr?.setEncoding("utf8");
    // The progress meter is on stderr so a `> file` of the summary stays clean.
    // Relayed as it arrives, because it is the only sign of life a cold
    // backfill has, and kept, because a failed step's stderr is its message.
    child.stderr?.on("data", (d: string) => {
      if (settled) return;
      stderr = keep(stderr, d);
      onStderr(d);
    });
    // A spawn that never happened has no exit code and no stderr of its own;
    // the error message is the only thing left to say what went wrong.
    child.on("error", (err: Error) => done(null, `${err.message}\n`));
    child.on("close", (code: number | null) => done(code, ""));
  });
}

const spawnOf = (deps: RepoHealthDeps): NonNullable<RepoHealthDeps["spawn"]> => deps.spawn ?? runStep;
const engineOf = (deps: RepoHealthDeps): NonNullable<RepoHealthDeps["engine"]> => deps.engine ?? resolveRepoHealthEngine;

/** One step, through whichever engine was resolved. The argv is built once,
 *  here, so the fake and the real spawn are handed the same thing. */
const step1 = (
  deps: RepoHealthDeps,
  engine: RepoHealthEngine,
  wt: string,
  step: RepoHealthStep,
  onStderr: (chunk: string) => void = () => {},
  scope: string | null = null,
): Promise<RepoHealthProc> => spawnOf(deps)(wt, step, onStderr, repoHealthArgv(engine, wt, step, scope));


/** The `head` and `behind` the tool prints beside the series.
 *
 *  They are read here rather than in `parseRepoHealthStatus` because they are
 *  not part of the series: `head` is where the repo is NOW and `behind` is the
 *  distance between the two. Both degrade to null on their own — `behind: null`
 *  is "could not tell", which the view's own comment insists is never 0. */
function headAndBehind(stdout: string): { head: { sha: string; ts: number } | null; behind: number | null } {
  let raw: Record<string, unknown> | null = null;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const v: unknown = JSON.parse(t);
      if (v && typeof v === "object" && !Array.isArray(v)) raw = v as Record<string, unknown>;
    } catch { /* not the line, keep looking */ }
  }
  if (!raw) return { head: null, behind: null };
  const h = raw.head as Record<string, unknown> | null | undefined;
  const sha = h && typeof h === "object" ? h.sha : null;
  const ts = h && typeof h === "object" ? h.ts : null;
  // `ts` is git seconds; the wire is milliseconds (see `secondsToMs`).
  const head = typeof sha === "string" && sha.length > 0 && typeof ts === "number" && Number.isFinite(ts) && ts > 0
    ? { sha, ts: secondsToMs(ts) }
    : null;
  const b = raw.behind;
  const behind = typeof b === "number" && Number.isInteger(b) && b >= 0 ? b : null;
  return { head, behind };
}

/**
 * What one `status` read says. Reading never refuses — a stale or mixed series
 * still answers — so anything but a clean exit 0 with a parseable line is
 * ABSENT rather than a wrong number.
 *
 * …but an absence with no sentence beside it is what this used to be, and it
 * was wrong. A repo the engine cannot read at all ("not a git repository") and
 * a repo nobody has measured yet both arrived as `series: null` and silence,
 * and on screen they are the same blank panel over two different next actions.
 * So a failed status now also carries `readError` — `classifyExit`'s sentence,
 * which is the engine's own words and not a paraphrase. It explains the
 * absence; it never fills it in.
 */
async function readStatus(
  wt: string,
  engine: RepoHealthEngine,
  deps: RepoHealthDeps,
  scope: string | null = null,
): Promise<{
  series: RepoHealthSeries | null;
  head: { sha: string; ts: number } | null;
  behind: number | null;
  measure: RepoHealthMeasure | null;
  readError: string | null;
}> {
  const proc = await step1(deps, engine, wt, "status", () => {}, scope);
  const none = { series: null, head: null, behind: null, measure: null };
  if (proc.timedOut) {
    return {
      ...none,
      readError:
        `status ran past ${Math.round(REPOHEALTH_TIMEOUT_MS / 1000)}s and its process group was killed — ` +
        `nothing was read, and nothing it had already written was undone.`,
    };
  }
  if (proc.code !== 0) {
    // A `status` cannot refuse (only `update` appends), but the classifier owns
    // every code and its wording, so take whichever half it filled in rather
    // than deciding here which ones are possible.
    const verdict = classifyExit(proc.code, proc.stderr);
    return { ...none, readError: verdict.error ?? verdict.refused?.text ?? null };
  }
  // The same line, read for what the ENGINE says about this tree — packs,
  // groups, the size of the job, the re-cut command. Leniently, because a repo
  // running its own older copy prints none of them and must still work.
  const measure = parseRepoHealthMeasure(proc.stdout);

  // THE ECHO CHECK. An engine that predates scopes ignores `--scope=` instead
  // of failing on it, so without this the daemon would read the whole repo,
  // believe it was reading a subtree, and write it into that subtree's series
  // — a reading of the wrong tree under the right name. Only a scoped read can
  // fail here: with no scope asked for there is nothing to disagree about.
  if (scope && measure?.scope !== scope) {
    // Named by WHERE the old engine is, the way `readPlot` names it: the two
    // cases have different fixes, and a sentence that guesses wrong sends the
    // reader to update a checkout that is already current.
    const where = engine.kind === "repo"
      ? `This repo carries its own ${REPOHEALTH_TOOL} and a repo that ships the engine is read with its own ` +
        `copy — update that copy, or remove it so this desktop's engine reads the tree.`
      : `That is this desktop's bundled engine, so updating the desktop's checkout is what reads a subtree.`;
    return {
      ...none,
      readError:
        `The engine that read this repo predates subtree readings — it ignored --scope=${scope} and would ` +
        `have measured the whole repo under that name. ${where}`,
    };
  }

  return {
    series: parseRepoHealthStatus(proc.stdout),
    ...headAndBehind(proc.stdout),
    measure,
    readError: null,
  };
}

/**
 * What one `plot` read says — the points and the tool's reading of them, or
 * nothing at all AND WHY.
 *
 * Nothing at all is a real answer here, and for a while it was always the same
 * one: `null`, which the view spells as "no plot" and the phone worded as
 * *refresh it to measure one*. Three different things arrive as that null and
 * only one of them is fixed by refreshing.
 *
 *  - **no series yet, or a line that failed validation** — the engine answered.
 *    `why` is null and the standing remedy is the right one. "No series yet"
 *    is the ordinary state of most repos on this desktop and the engine
 *    reports it as a NON-ZERO exit, so the test for it is not the exit code:
 *    it is whether `status` found a series at all, which was read a moment
 *    ago. Relaying the engine's own words here would also relay its `run
 *    node tools/repohealth.mjs update first`, a relative path that is wrong
 *    in every tree the bundled engine measures.
 *  - **exit 2** — this engine has no `plot` subcommand. It is the tool's own
 *    code for a verb it does not have, and it is the state the whole
 *    `--root=` design leaves behind: a worktree carrying its own copy of
 *    `tools/repohealth.mjs` is spawned WITH that copy and WITHOUT the flag,
 *    because a repo that ships the tool is the authority on its own root. So
 *    the desktop's newer engine is not used there, refreshing runs the same
 *    old copy again, and no tap on that screen can ever produce a chart. The
 *    sentence has to say where the fix is instead.
 *  - **killed on the timeout, or any other exit** — the engine failed, which
 *    is a different sentence again and is the classifier's to word.
 *
 * `plot: null` beside a live `series` is unchanged by all of this: one reader
 * falling over must not take the other's answer with it, and the reason rides
 * beside the null rather than in place of it. Never a half-parsed plot: a
 * series drawn with one of its points invented is worse than a series not
 * drawn.
 */
async function readPlot(
  wt: string,
  engine: RepoHealthEngine,
  deps: RepoHealthDeps,
  /** Whether `status` found a series a moment ago. A plot that failed over a
   *  repo nobody has measured needs no sentence of its own — the series is
   *  the absence, and the sheet only asks this question where one exists. */
  hasSeries: boolean,
  scope: string | null = null,
): Promise<{ plot: RepoHealthPlot | null; why: string | null }> {
  const proc = await step1(deps, engine, wt, "plot", () => {}, scope);
  if (proc.timedOut) {
    return {
      plot: null,
      why:
        `The chart could not be read: \`plot\` ran past ${Math.round(REPOHEALTH_TIMEOUT_MS / 1000)}s and its ` +
        `process group was killed. The series beside it was read on its own and is unaffected.`,
    };
  }
  if (proc.code === 2) {
    // Named by WHERE the older copy is, because that is the whole difference
    // between a fix and a tap that does nothing.
    const where = engine.kind === "repo"
      ? `This repo carries its own ${REPOHEALTH_TOOL}, and a repo that ships the engine is read with its ` +
        `own copy — so refreshing runs the same one again. Update the copy in this repo to draw a chart.`
      : `That is this desktop's bundled engine, so updating the desktop's checkout is what draws a chart.`;
    return { plot: null, why: `The engine that read this repo has no \`plot\` subcommand — it exited 2 on it. ${where}` };
  }
  if (proc.code !== 0) {
    if (!hasSeries) return { plot: null, why: null };
    const verdict = classifyExit(proc.code, proc.stderr);
    const said = verdict.error ?? verdict.refused?.text ?? null;
    return { plot: null, why: said ? `The chart could not be read: ${said}` : null };
  }
  return { plot: parseRepoHealthPlot(proc.stdout), why: null };
}

/** The narrative the `narrate` step wrote, if it is there. A worktree that has
 *  never been narrated has none, which is a state with a next action rather
 *  than an error. */
function readNarrative(wt: string): RepoHealthView["narrative"] {
  try {
    const abs = join(wt, REPOHEALTH_MD);
    const st = statSync(abs);
    return { text: readFileSync(abs, "utf8"), mtime: st.mtimeMs, relPath: REPOHEALTH_MD };
  } catch {
    return null;
  }
}

/** The drawn page, by path and age. The bytes are NOT read — it is an outbox
 *  artifact, and the gallery route already serves those. */
function readPage(wt: string): RepoHealthView["page"] {
  try {
    return { relPath: REPOHEALTH_HTML, mtime: statSync(join(wt, REPOHEALTH_HTML)).mtimeMs };
  } catch {
    return null;
  }
}

/** The stderr lines that are not the progress meter — on a CLEAN exit these are
 *  the tool's warnings (a mixed series, rows whose commits left first-parent),
 *  which are facts about the reading and not a failed run. */
function warningsIn(stderr: string): string[] {
  return stderr
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0 && parseRepoHealthProgress(l) === null);
}

/**
 * What the phone is shown: whether the tool is here, what the series says, what
 * is in flight and how the last run ended.
 *
 * Read-only. It spawns `status` and then `plot`, both of which read the series
 * file and print one line — opening the sheet must not move the series it is
 * about to draw, and `update` is the only thing in that tool that writes. The
 * plot degrades on its own: a `plot` that failed leaves `plot: null` and every
 * other field of this view exactly as it would have been.
 */
export async function readRepoHealth(
  wt: string,
  deps: RepoHealthDeps = {},
  /** The subtree to read, or null for the repo. A scoped view is the same
   *  shape read over a different series file — see `scope.mjs` in the tool. */
  scope: string | null = null,
): Promise<RepoHealthView> {
  const now = deps.now ?? Date.now;
  const engine = engineOf(deps)(wt);
  const key = keyOf(wt, scope);
  const base = {
    run: running.get(key) ?? null,
    last: lastOutcome.get(key) ?? null,
    readAt: now(),
    // The cap belongs to the DESKTOP, so it rides on every answer including
    // the one where nothing ran: a phone saying how long a backfill may take
    // must not hold its own copy of a number this desktop can change.
    stepTimeoutMs: REPOHEALTH_TIMEOUT_MS,
    engine: engine ? { kind: engine.kind } : null,
    // WHICH reading this is, and which others exist. Both ride on every answer
    // including the one where nothing ran: a client that cannot see the list
    // cannot offer the subtrees, and one that cannot see which it is holding
    // would draw a subtree's paths as though they were the repo's.
    scope,
    scopes: readScopes(wt),
  };
  if (!engine) {
    // No spawn, and the sentence is about this DESKTOP. Before `--root`, a
    // repo with no copy of the tool was the ordinary case and the absence
    // needed no explaining; now it is a fault, and an unexplained fault is
    // indistinguishable from a repo nobody measured.
    return {
      // `plotError` is null and not a second copy of `noEngineText()`: with no
      // engine there is no chart AND no series, and `readError` above already
      // says why. Two sentences for one absence is the sheet saying it twice.
      tool: false, head: null, series: null, behind: null, plot: null, plotError: null,
      narrative: null, page: null, measure: null, readError: noEngineText(), ...base,
    };
  }
  const { series, head, behind, measure, readError } = await readStatus(wt, engine, deps, scope);
  // One after the other, not in parallel: both are reads of the same file, the
  // pair costs about a tenth of a second, and a sheet opening must have exactly
  // two spawns in the log for the assertion that it has no THIRD one to mean
  // anything.
  const { plot, why: plotError } = await readPlot(wt, engine, deps, series !== null, scope);
  return {
    tool: true,
    head,
    series,
    behind,
    measure,
    readError,
    plot,
    plotError,
    // Root only, both of them. `narrate` and `html` write one file for the
    // repo and the engine refuses them under a scope, so a scoped view that
    // carried the repo's narrative would present a document about the whole
    // tree as this subtree's reading.
    narrative: scope ? null : readNarrative(wt),
    page: scope ? null : readPage(wt),
    ...base,
  };
}

/**
 * `update` → `narrate` → `html`, and an answer whatever happens.
 *
 * It never throws on a non-zero exit. A refusal (exit 3) and a failure (1, or a
 * kill) are both things the tool DID, and both are worth reading; an exception
 * here would turn either into the phone's generic error state and lose the
 * tool's own sentence. The chain stops at the first step that is not ok —
 * narrating a series the tool has just declined to append to would present
 * yesterday's reading as today's.
 */
export function refreshRepoHealth(
  wt: string,
  deps: RepoHealthDeps = {},
  scope: string | null = null,
): Promise<RepoHealthView> {
  const key = keyOf(wt, scope);
  const joined = inflight.get(key);
  if (joined) return joined;
  const started = (async () => {
    try {
      return await runRefresh(wt, deps, scope);
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, started);
  return started;
}

async function runRefresh(wt: string, deps: RepoHealthDeps, scope: string | null = null): Promise<RepoHealthView> {
  const now = deps.now ?? Date.now;
  const engine = engineOf(deps)(wt);
  // Nothing to run it with: the read answers the same view, sentence included,
  // and no `last` outcome is recorded — a run that never started is not a run
  // that failed.
  if (!engine) return readRepoHealth(wt, deps, scope);

  const key = keyOf(wt, scope);
  const startedAt = now();
  const run: RepoHealthRun = { state: "running", startedAt, note: null };
  running.set(key, run);

  let step: RepoHealthOutcome["step"] = null;
  let refused: RepoHealthOutcome["refused"] = null;
  let error: string | null = null;
  let added: number | null = null;
  const warnings: string[] = [];

  try {
    // A scope measures and stops. `narrate` and `html` write one file for the
    // repo — the engine refuses both under a scope — so running them here
    // would either fail the refresh or overwrite the repo's own narrative with
    // a subtree's.
    for (const s of (scope ? SCOPED_REFRESH_STEPS : REFRESH_STEPS)) {
      step = s as RepoHealthOutcome["step"];
      const proc = await step1(deps, engine, wt, s, (chunk) => {
        for (const line of chunk.split("\n")) {
          const note = parseRepoHealthProgress(line);
          if (note) run.note = note;
        }
      }, scope);
      if (proc.timedOut) {
        // The words matter: the run was CUT, not answered. Whatever the tool
        // had already appended is on disk and the next refresh carries on from
        // it — "it failed" would send the reader looking for a bug in the tool.
        error = `${s} ran past ${Math.round(REPOHEALTH_TIMEOUT_MS / 1000)}s and its process group was killed — nothing it had already written was undone.`;
        break;
      }
      const verdict = classifyExit(proc.code, proc.stderr);
      if (verdict.refused || verdict.error) {
        refused = verdict.refused;
        error = verdict.error;
        break;
      }
      // Only a clean step's stderr is a warning; a failed step's stderr is the
      // message, and saying it twice reads as two problems.
      warnings.push(...warningsIn(proc.stderr));
      if (s === "update") added = parseUpdateSummary(proc.stdout).added;
    }
  } finally {
    running.delete(key);
  }

  lastOutcome.set(key, {
    at: now(),
    ok: !refused && !error,
    ms: now() - startedAt,
    step,
    refused,
    error,
    added,
    warnings,
  });
  return readRepoHealth(wt, deps, scope);
}
