/**
 * The tasks slice of `sidecar.ts` — see that file's header for the seam's rules.
 */
import { detectHeadlessLimit, limitNote } from "../limit.js";
import { sayOnce, sidecarPlan } from "./sidecarroute.js";
import { envelopeUsage, runHeadlessClaude } from "./sidecarclaude.js";
import type { EnvelopeUsage } from "./sidecarclaude.js";
import { chatCompletion } from "./sidecaropenai.js";

// ── The summary task ───────────────────────────────────────────────────────

export interface SummaryRequest {
  readonly cwd: string;
  /** The whole prompt, transcript included — as `sessions/record.ts` assembles it. */
  readonly prompt: string;
  /** The system prompt that replaces Claude Code's own. */
  readonly system: string;
  /** The model the claude engine runs on (`WATERPLANE_SUMMARY_MODEL`). */
  readonly model: string;
}

/** One line, normalised the way the session row stores it. */
const tidy = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 240);

/**
 * The tab name call (`sessions/record.ts`'s `nameTab`/`nameNow`) — the cheap
 * toolless completion every other unattended call copies its flags from. (The
 * identifiers keep the name of the per-turn summary it was written for.)
 *
 * Returns "" on every failure, which the callers read as "leave the existing
 * name alone". That contract is older than this file and is not being
 * changed: it is the reason a broken sidecar costs an absent name rather than
 * a wrong one.
 */
export async function runSummaryTask(req: SummaryRequest): Promise<string> {
  const plan = sidecarPlan("summary");
  if (plan.engine === "refused") { sayOnce(plan.reason); return ""; }
  if (plan.engine === "openai-compat") {
    return tidy(await chatCompletion(plan, { prompt: req.prompt, system: req.system }));
  }
  // ── claude engine: the call as it has always been ──────────────────────
  const run = await runHeadlessClaude({
    cwd: req.cwd,
    args: [
      "-p", "--output-format", "json",
      "--model", req.model,
      // Skip the PROJECT's settings — this is where its CLAUDE.md comes from.
      "--setting-sources", "user",
      // Nothing to read: the transcript is in the prompt.
      "--tools", "",
      "--system-prompt", req.system,
    ],
    prompt: req.prompt,
    timeoutMs: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  // A run the account refused summarised nothing: its "summary" would be the
  // quota banner, which is both false as a summary and the last text that
  // should be paraphrased back onto a session's screen.
  if (detectHeadlessLimit(run.stdout, run.stderr).blocked) return "";
  let text = run.stdout;
  try {
    const env = JSON.parse(text);
    // An errored run's `result` is the error ("Failed to authenticate: OAuth
    // session expired…"), not an answer — it once became a tab's name.
    if (env && env.is_error === true) return "";
    if (env && typeof env.result === "string") text = env.result;
  } catch { /* raw */ }
  return tidy(text);
}

// ── The smart pick task ────────────────────────────────────────────────────

export interface SmartPickRequest {
  readonly cwd: string;
  /** The whole prompt — the repo's waiting items and its cheap facts, as JSON. */
  readonly prompt: string;
  /** The system prompt that replaces Claude Code's own. */
  readonly system: string;
  /** The model the claude engine runs on (`WATERPLANE_SMARTPICK_MODEL`). */
  readonly model: string;
  /**
   * The watchdog, in milliseconds.
   *
   * Passed in rather than read here because this one is NOT the sidecar's 120 s:
   * a smart-pick pass gates a fire, so a person is waiting on the other end of
   * it, and the caller owns that trade (`WATERPLANE_SMARTPICK_TIMEOUT_MS`, 20 s).
   */
  readonly timeoutMs: number;
}

export interface SmartPickRun {
  /** The model's answer, envelope unwrapped. "" when there is none. */
  readonly text: string;
  /** No usable answer came back, for any reason. */
  readonly failed: boolean;
  /** The ACCOUNT is out of quota — not an error, and a different sentence. */
  readonly limited: boolean;
  /** What went wrong, in words, when anybody knew. */
  readonly detail?: string;
  /** Read from the envelope when it carried one; absent otherwise. Never derived. */
  readonly usage?: EnvelopeUsage;
  /** `total_cost_usd`, when the envelope carried one. Never derived. */
  readonly usd?: number;
  /** Wall clock around the call, which is a fact this end always has. */
  readonly durationMs: number;
}

/**
 * One grooming pass over a repo's waiting backlog items.
 *
 * ── The argv, and why every flag of `runSummaryTask`'s is still here ────────
 *
 * CLAUDE.md's rule is that a new unattended `claude -p` starts from the
 * summary's flags and justifies every one it DROPS. Nothing is dropped:
 *
 *  • `-p --output-format json` — the envelope is both the answer and the error
 *    channel, and now also the only honest cost line (`envelopeUsage`).
 *  • `--model <req.model>` — the cheapest model that can do the job, exactly as
 *    the summary does. Defaulted by the caller, overridable per desktop.
 *  • `--setting-sources user` — no PROJECT settings, so no repo `CLAUDE.md`.
 *    This repo's is 12k chars of always-on context to answer a question about
 *    six sentences of backlog text, and the pass is not editing any code.
 *  • `--tools ""` — the items and the repo facts are IN the prompt. A pass with
 *    tools could read the repo, and a pass that can read the repo is a full
 *    agent turn per pick, which is the thing this feature must never become.
 *    It is also the mechanical guarantee behind the harder rule: this pass may
 *    never type into a session, and with no tools there is nothing to type with.
 *  • `--system-prompt <req.system>` — its own contract, replacing Claude Code's.
 *
 * The one thing that differs from `runSummaryTask` is a DELIBERATE addition,
 * not a drop: `timeoutMs` is the caller's (20 s, not 60 s), because a person's
 * next backlog item is held behind this call and the summary's is not.
 *
 * `maxBuffer` is 1 MiB rather than the summary's 4 MiB: the contract is one
 * small JSON object, and anything approaching a megabyte of it is a model that
 * has already lost the plot.
 *
 * ── What a failure is ──────────────────────────────────────────────────────
 *
 * Text "" and `failed`. The caller's whole job on that is to fire the backlog
 * in exactly the order it would have had without this feature — which is why
 * nothing here ever half-answers.
 */
export async function runSmartPickTask(req: SmartPickRequest): Promise<SmartPickRun> {
  const started = Date.now();
  const since = (): number => Date.now() - started;

  const plan = sidecarPlan("smartpick");
  if (plan.engine === "refused") {
    sayOnce(plan.reason);
    return { text: "", failed: true, limited: false, detail: plan.reason, durationMs: since() };
  }
  if (plan.engine === "openai-compat") {
    // No `tidy()` here, and that is the point of not reusing the summary's
    // path: `tidy` squashes whitespace and clips to 240 chars, which would
    // quietly truncate a JSON answer into something `JSON.parse` refuses.
    // No usage either — an OpenAI-compatible body carries its own `usage`
    // shape, `chatCompletion` does not return it, and inventing one from the
    // prompt's length is the wrong number this whole seam exists to refuse.
    const text = await chatCompletion(plan, { prompt: req.prompt, system: req.system, timeoutMs: req.timeoutMs });
    return {
      text,
      failed: !text,
      limited: false,
      detail: text ? undefined : "the local engine answered nothing",
      durationMs: since(),
    };
  }

  // ── claude engine ────────────────────────────────────────────────────────
  const run = await runHeadlessClaude({
    cwd: req.cwd,
    args: [
      "-p", "--output-format", "json",
      "--model", req.model,
      // Skip the PROJECT's settings — this is where its CLAUDE.md comes from.
      "--setting-sources", "user",
      // Nothing to read: the items and the repo facts are in the prompt.
      "--tools", "",
      // ── The one flag this call ADDS, and the measurement that put it here ──
      //
      // `envelopeUsage`'s header warned that thinking, not input size, is what
      // this feature is billed for. Phase 2 measured the real prompt against the
      // installed binary and the number was worse than the warning: the SAME
      // three-item pass, five runs —
      //
      //   thinking on   $0.0067 – $0.025, 13 s – 36 s, 1,044 – 3,371 thinking tokens
      //   --effort low  $0.0155, 28 s, 2,407 thinking tokens (barely moves it)
      //   this flag     $0.0014, 2.8 s, 0 thinking tokens, identical conclusion
      //
      // Twelve times the money and ten times the wall clock, for a list-tidying
      // job over six sentences. And the clock is not a nicety here: a person's
      // next backlog item is HELD behind this call, so a 30 s pass blew through
      // the 20 s watchdog on two runs in three — the feature would have paid for
      // a completion it then threw away, every time, for ever. Asking for it in
      // the system prompt does not work; it was asked for and 2,644 thinking
      // tokens were spent anyway.
      //
      // Nothing is dropped — CLAUDE.md's rule is about the flags a new
      // unattended call loses, and this one KEEPS all of `runSummaryTask`'s. It is
      // added here and nowhere else: a summary is prose about a conversation and
      // a review is a judgement about code, and neither of those is a job where
      // the thinking is the waste.
      //
      // A `claude` too old to know the flag exits non-zero, which is `failed`,
      // which fires the backlog in exactly the order it already had and says so
      // on the strip. That is the same degradation as every other failure here.
      "--thinking", "disabled",
      "--system-prompt", req.system,
    ],
    prompt: req.prompt,
    timeoutMs: req.timeoutMs,
    maxBuffer: 1024 * 1024,
  });

  // Asked FIRST, exactly as the summary asks it: an account block's envelope
  // still parses and still has a `result` string in it, and that string is a
  // quota banner. Reading it as a grooming answer would put the banner's words
  // where a sanitiser expects JSON — and, worse, count it as a real pass.
  const limit = detectHeadlessLimit(run.stdout, run.stderr);
  const { usage, usd } = envelopeUsage(run.stdout);
  if (limit.blocked) {
    return { text: "", failed: false, limited: true, detail: limitNote(limit, "picked"), usage, usd, durationMs: since() };
  }

  let text = run.stdout;
  try {
    const env = JSON.parse(text) as { result?: unknown };
    if (env && typeof env.result === "string") text = env.result;
  } catch { /* raw — a stdout that is not an envelope is still worth a parse attempt downstream */ }
  text = text.trim();

  return {
    text,
    failed: !text,
    limited: false,
    detail: text ? undefined : (run.err?.message || "the model answered nothing"),
    usage,
    usd,
    durationMs: since(),
  };
}
