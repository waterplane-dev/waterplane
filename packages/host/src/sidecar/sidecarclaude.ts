/**
 * The claude slice of `sidecar.ts` — see that file's header for the seam's rules.
 */
import { execFile, spawn } from "node:child_process";
import { claudeBackend } from "../backends/index.js";
import { sayOnce, sidecarPlan } from "./sidecarroute.js";
import type { SidecarTask } from "./sidecarroute.js";
import { trustRefusal, workspaceTrust } from "./sidecartrust.js";

// ── The claude engine ──────────────────────────────────────────────────────

export interface HeadlessRun {
  readonly stdout: string;
  readonly stderr: string;
  /** The process failed (non-zero exit, timeout, not spawnable). */
  readonly failed: boolean;
  /** `execFile`'s error, kept so a caller can say what it was. */
  readonly err: Error | null;
}

export interface HeadlessRequest {
  readonly cwd: string;
  /** argv AFTER the binary. */
  readonly args: readonly string[];
  /** Written to stdin, as every caller here already does. */
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly maxBuffer: number;
  /**
   * **Watch the run happen.** Called with stdout as it arrives, in whatever
   * chunks the pipe delivers — a caller that wants lines splits them itself,
   * because a chunk boundary falls mid-line and only the caller knows what a
   * line means to it.
   *
   * Asking for this changes HOW the process is read and nothing about what it
   * is: a streamed run is spawned rather than `execFile`d, so a `-p` printing
   * megabytes of tool output on its way to a twenty-minute answer cannot be
   * killed by `maxBuffer` with its work half done. What is RETAINED for
   * `stdout` is then the tail (`keepBytes`), because the point of watching is
   * that the caller already kept what it cared about.
   *
   * **Never called once the promise has answered.** A timed-out run resolves at
   * the deadline and its corpse keeps printing while it is chased, and a
   * watcher told about a run it has already been given the verdict for writes a
   * reading of something that is over — see the header of `streamClaude`.
   */
  readonly onOut?: (chunk: string) => void;
  /** With `onOut`, how much stdout the returned `stdout` keeps — the END of it,
   *  which is where a `-p` envelope and a usage-limit notice are. */
  readonly keepBytes?: number;
}

/** How much of a streamed run's stdout is kept when the caller did not say. */
const STREAM_KEEP_BYTES = 256 * 1024;

/**
 * One headless `claude -p`, prompt on stdin — the shape all three callers had.
 *
 * Returns the raw streams rather than an interpretation: the envelope, the
 * verdict JSON and the usage-limit read are the CALLERS' contracts and stay
 * where they are. This function's only opinion is that a run is a process.
 */
export function runHeadlessClaude(req: HeadlessRequest): Promise<HeadlessRun> {
  if (req.onOut) return streamClaude(req, req.onOut);
  return new Promise((resolve) => {
    const proc = execFile(
      claudeBackend.bin(), [...req.args],
      { cwd: req.cwd, timeout: req.timeoutMs, maxBuffer: req.maxBuffer, env: { ...process.env, ...claudeBackend.spawnEnv } },
      (err, stdout, stderr) => {
        resolve({
          stdout: (stdout || "").toString(),
          stderr: (stderr || "").toString(),
          failed: !!err,
          err: err ?? null,
        });
      },
    );
    proc.stdin?.end(req.prompt);
  });
}

/**
 * The same run, read as it happens.
 *
 * `execFile` cannot do this job: it buffers the whole of stdout and kills the
 * child the moment that passes `maxBuffer`, and a `--output-format stream-json`
 * run prints every tool result it takes — so the one caller that wants to watch
 * would be the one caller whose process dies half way through a twenty-minute
 * read. So the streamed branch spawns, hands every chunk over, and keeps only
 * the tail for the returned `stdout`.
 *
 * Everything else is `execFile`'s contract on purpose: a timeout kills the
 * child and reports `failed` with an error that says so, a spawn that never
 * happened is `failed`, and the streams come back as strings — because the
 * callers' readers (`detectHeadlessLimit`, the envelope parse) must not have to
 * know which branch ran them.
 *
 * ── The run is a process GROUP, and the answer is FINAL ─────────────────────
 *
 * Two rules here are invisible until they cost a day.
 *
 * **A kill must reach the group.** `claude -p` is a shell away from the tools
 * it runs: the child spawns `sh`, `sh` spawns `npm test`, and a `proc.kill`
 * with no `detached` hits only the direct child. The orphan then holds the pipe
 * open (measured: a `sleep 30` behind a killed `sh` made the timeout case of
 * `sidecarstream.test.mjs` take 30.5 s of every `npm run test:host`), and, far
 * worse for `assess.ts`, an orphaned `claude` that outlives SIGTERM can write
 * `.waterplane/assess-out.json` AFTER the NEXT run's `rmSync` — the stale output file
 * that file's header exists to prevent, arriving from a run nobody is watching
 * any more. So the child is its own group leader and both signals go to the
 * group.
 *
 * **Nothing is handed over after the promise has answered.** A timeout resolves
 * at the deadline and the corpse is chased separately, so chunks keep arriving
 * for as long as the kill takes. Passing them on calls a watcher that has
 * already been told the run is over — for `assess.ts` that is a `setLive` on a
 * settled row, which puts memory out of step with the disk until the next
 * `set()` on any run persists the divergence. Appending them to the retained
 * tail is merely pointless (the string was copied into the resolve), and
 * splitting the two guards would leave "what was returned" and "what was kept"
 * describing different runs, so ONE guard covers both.
 */
function streamClaude(req: HeadlessRequest, onOut: (chunk: string) => void): Promise<HeadlessRun> {
  return new Promise((resolve) => {
    const keep = Math.max(4096, req.keepBytes ?? STREAM_KEEP_BYTES);
    let out = "";
    let err = "";
    let settled = false;
    let timedOut = false;
    // `detached` makes the child a process-group leader, which is the only way
    // a signal can reach what it spawned. It is NOT "run in the background":
    // the pipes are still ours and the child is never `unref`d.
    const proc = spawn(claudeBackend.bin(), [...req.args], { cwd: req.cwd, detached: true, env: { ...process.env, ...claudeBackend.spawnEnv } });
    /** Signal the whole group, since the tools are grandchildren. A group that
     *  has already gone throws ESRCH — that is the good case, not an error. */
    const killGroup = (sig: NodeJS.Signals): void => {
      try {
        if (proc.pid) process.kill(-proc.pid, sig);
        else proc.kill(sig);
      } catch { /* already gone, or never started */ }
    };
    /**
     * A timeout ANSWERS, it does not wait to be let go.
     *
     * `close` fires when every pipe is done, which a killed process's own
     * children can hold open — and this promise is awaited by a durable run
     * whose row says `running` until it resolves. So the verdict is given at
     * the deadline, with whatever was printed by then, and the corpse is
     * chased separately.
     */
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 2000).unref?.();
      done(true, new Error(`timed out after ${req.timeoutMs} ms`));
    }, req.timeoutMs);
    const done = (failed: boolean, error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: out, stderr: err, failed, err: error });
    };
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (d: string) => {
      // Past the answer, this chunk belongs to a run that has already been
      // reported — see the header: handing it over is a reading of a settled
      // run, and keeping it is bytes nobody will read.
      if (settled) return;
      // The caller sees everything; what is KEPT is the tail, so a run that
      // prints 80 MB of tool output still answers with the envelope at the end
      // of it and this daemon holds a quarter of a megabyte.
      try { onOut(d); } catch { /* a reader that throws must not kill the run */ }
      out = (out + d).slice(-keep);
    });
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (d: string) => { if (!settled) err = (err + d).slice(-keep); });
    proc.on("error", (e: Error) => done(true, e));
    proc.on("close", (code: number | null) => {
      // A timeout has already answered; anything arriving now is the kill.
      if (timedOut) return;
      done(code !== 0, code === 0 ? null : new Error(`exited with code ${code}`));
    });
    try { proc.stdin?.end(req.prompt); } catch { /* the error event has it */ }
  });
}

/**
 * What one headless call COST, out of its own envelope.
 *
 * ── The measurement this is written against (2026-09-17, this desktop) ──────
 *
 * `echo hi | claude -p --output-format json --model haiku --setting-sources
 * user --tools "" --system-prompt "…"` in this repo answers a JSON object
 * carrying, at the top level: `result`, `is_error`, `subtype` ("success"),
 * `session_id`, `num_turns`, `duration_ms`, `total_cost_usd`; a `usage` object
 * with `input_tokens`, `output_tokens`, `cache_read_input_tokens` and
 * `cache_creation_input_tokens`; and a `modelUsage["<model-id>"]` object with
 * the camel-cased same (`inputTokens`, `outputTokens`, `cacheReadInputTokens`,
 * `cacheCreationInputTokens`, `costUSD`, `contextWindow`). The flat `usage` is
 * what is read here — `modelUsage` is keyed by a model id this daemon does not
 * otherwise know, and there is nothing in it the flat object does not have.
 *
 * Two more facts from that run, written down here because this is the seam a
 * later phase reaches for and `docs/notes/host.md` does not describe the
 * feature yet:
 *
 *  • **`claude -p` DOES write a transcript**, at
 *    `~/.claude/projects/<cwd-slug>/<session_id>.jsonl`, keyed by the cwd it
 *    ran in. So `tokenstats.ts` already attributes an unattended pass to the
 *    repo it groomed, per repo, with no ledger code and no accounting of our
 *    own. (This is what `PLAN-SMARTPICK.md` open question 1 was asking.)
 *  • **Thinking is on by default and will dominate the bill.** A trivial
 *    one-word haiku reply cost **$0.0049** and spent **548 thinking tokens**
 *    (`usage.output_tokens_details.thinking_tokens`). At one pass per pick that
 *    is the cost of this feature — not the 2–4k of items going in. Whoever owns
 *    the prompt owns that number.
 *
 * ── Why it degrades to ABSENT and never to a zero ──────────────────────────
 *
 * This is the only honest cost line an unattended call has, and it is shown to
 * a person as tokens and dollars. A `0` where the envelope said nothing is a
 * wrong number wearing a true number's clothes, and nothing downstream can tell
 * the two apart afterwards. So: all four token kinds must be finite numbers or
 * `usage` is absent altogether (a partial envelope is a shape this does not
 * recognise, and a three-quarters-filled four-kind count is exactly the wrong
 * number the rule forbids), and `total_cost_usd` is read on its own — a run may
 * legitimately report tokens with no price, or a price with no breakdown.
 *
 * Pure, and exported for that reason: every way a `-p` envelope can be
 * unreadable is a fixture, not a spawned process.
 */
export interface EnvelopeUsage {
  readonly inTok: number;
  readonly outTok: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export function envelopeUsage(stdout: string): { usage?: EnvelopeUsage; usd?: number } {
  let env: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    env = parsed as Record<string, unknown>;
  } catch { return {}; }

  const out: { usage?: EnvelopeUsage; usd?: number } = {};

  const u = env.usage;
  if (u && typeof u === "object" && !Array.isArray(u)) {
    const r = u as Record<string, unknown>;
    const fin = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
    const inTok = fin(r.input_tokens);
    const outTok = fin(r.output_tokens);
    const cacheRead = fin(r.cache_read_input_tokens);
    const cacheWrite = fin(r.cache_creation_input_tokens);
    if (inTok != null && outTok != null && cacheRead != null && cacheWrite != null) {
      out.usage = { inTok, outTok, cacheRead, cacheWrite };
    }
  }

  const usd = env.total_cost_usd;
  if (typeof usd === "number" && Number.isFinite(usd) && usd >= 0) out.usd = usd;

  return out;
}

/** What a tool-using task gets back: a run, or a refusal instead of one. */
export type ToolTaskRun = HeadlessRun & { readonly refused?: string };

/**
 * Run a task that NEEDS tools, through its route.
 *
 * Today every such route is `claude-p` and this is the old call verbatim —
 * behind one gate: a folder Claude Code does not trust is refused, because a
 * tool task keeps project settings and `-p` would load its hooks without
 * asking (`workspaceTrust`). A refusal produces no run at all: empty streams,
 * `failed`, and the sentence — which the caller surfaces as the row's detail,
 * because a person who misrouted a knob, or opened a repo nobody trusted, needs
 * to read that, not "the assessment wrote no file".
 */
export async function runToolTask(task: SidecarTask, req: HeadlessRequest): Promise<ToolTaskRun> {
  const plan = sidecarPlan(task);
  if (plan.engine === "refused") {
    sayOnce(plan.reason);
    return { stdout: "", stderr: "", failed: true, err: null, refused: plan.reason };
  }
  const untrusted = trustRefusal(req.cwd, await workspaceTrust(req.cwd));
  if (untrusted) {
    sayOnce(untrusted);
    return { stdout: "", stderr: "", failed: true, err: null, refused: untrusted };
  }
  return runHeadlessClaude(req);
}
