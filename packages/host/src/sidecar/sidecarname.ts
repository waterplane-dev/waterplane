/**
 * The name slice of `sidecar.ts` — see that file's header for the seam's rules.
 */
import { detectHeadlessLimit, limitNote } from "../limit.js";
import { sayOnce, sidecarPlan } from "./sidecarroute.js";
import type { SidecarTask } from "./sidecarroute.js";
import { envelopeUsage, runHeadlessClaude } from "./sidecarclaude.js";
import type { EnvelopeUsage } from "./sidecarclaude.js";
import { chatCompletion } from "./sidecaropenai.js";

// ── The naming task ────────────────────────────────────────────────────────

export interface NameRequest {
  readonly cwd: string;
  /** The whole prompt — one batch of items, ids and words, as JSON. */
  readonly prompt: string;
  /** The system prompt that replaces Claude Code's own. */
  readonly system: string;
  /** The model the claude engine runs on (`WATERPLANE_NAME_MODEL`). */
  readonly model: string;
  /** The watchdog, in milliseconds. The caller's, for `runSmartPickTask`'s
   *  reason: a naming pass is bounded by what the person who tapped it is
   *  willing to wait, and this module does not know that number. */
  readonly timeoutMs: number;
}

export interface NameRun {
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
 * One batch of backlog items, titled.
 *
 * ── The argv is `runSmartPickTask`'s, verbatim, and every flag is justified ─
 *
 * CLAUDE.md's rule is that a new unattended `claude -p` starts from
 * `runSummaryTask`'s flags (the tab name's) and justifies every one it DROPS. **This call drops
 * none of them**, and adds the one the smart pick added:
 *
 *  • `-p --output-format json` — the envelope is the completion signal, the
 *    error channel and the only honest cost line (`envelopeUsage`). It is never
 *    the content: the content is the JSON inside `result`.
 *  • `--model <req.model>` — the cheapest model that can do the job, exactly as
 *    the summary does. `WATERPLANE_NAME_MODEL`, defaulted by the caller.
 *  • `--setting-sources user` — no PROJECT settings, so no repo `CLAUDE.md`.
 *    This repo's is 12k chars of always-on context, and the question is "what
 *    should these six sentences be called": the most expensive possible way to
 *    answer it would be to read the repo's instructions first.
 *  • `--tools ""` — the items' own words are IN the prompt and there is nothing
 *    to go and read. It is also the mechanical guarantee behind the rule that
 *    matters: a naming pass may never touch the repo, and with no tools there
 *    is nothing to touch it with.
 *  • `--thinking disabled` — the smart pick's measurement, and this job is even
 *    more of a fit for it: titling a sentence is not a problem thinking
 *    improves, and thinking is the whole of what a pass like this costs (a
 *    trivial haiku reply measured 548 thinking tokens at $0.0049). Asking for
 *    brevity in the system prompt does not work; it was asked for there too,
 *    and the flag is what actually stops it.
 *  • `--system-prompt <req.system>` — its own contract, replacing Claude Code's.
 *
 * `maxBuffer` is 1 MiB, the smart pick's, for the smart pick's reason: the
 * contract is one small JSON object and anything approaching a megabyte of it
 * is a model that has lost the plot.
 *
 * ── The one thing it does NOT copy from the smart pick ─────────────────────
 *
 * The local branch runs no `tidy()` — the summary's whitespace-squash and
 * 240-char clip would turn a JSON document into something `JSON.parse` refuses,
 * which is the same reason `runSmartPickTask` does not use it. The text comes
 * back exactly as the server wrote it and the caller parses it.
 *
 * ── What a failure is ──────────────────────────────────────────────────────
 *
 * Text "" and `failed`. Every caller treats that the way every other sidecar
 * caller treats an empty result: nothing is written, and the rows keep whatever
 * they were already called.
 */
export async function runNameTask(req: NameRequest): Promise<NameRun> {
  return runTextTask("name", req);
}

/**
 * The same call, routed by a DIFFERENT knob — `commit`, for the commit message
 * a person asks for from the phone (`commitmsg.ts`).
 *
 * Deliberately the same function and not a copy: every flag above is a
 * measurement, and a second headless call with its own hand-written argv is how
 * one of them quietly stops being true. What differs between the two tasks is
 * the PROMPT, the model and which variable routes it — all of which are the
 * caller's, and the routing knob is this argument.
 */
export async function runCommitTask(req: NameRequest): Promise<NameRun> {
  return runTextTask("commit", req);
}

async function runTextTask(task: SidecarTask, req: NameRequest): Promise<NameRun> {
  const started = Date.now();
  const since = (): number => Date.now() - started;

  const plan = sidecarPlan(task);
  if (plan.engine === "refused") {
    sayOnce(plan.reason);
    return { text: "", failed: true, limited: false, detail: plan.reason, durationMs: since() };
  }
  if (plan.engine === "openai-compat") {
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
      "--setting-sources", "user",
      "--tools", "",
      "--thinking", "disabled",
      "--system-prompt", req.system,
    ],
    prompt: req.prompt,
    timeoutMs: req.timeoutMs,
    maxBuffer: 1024 * 1024,
  });

  // Asked FIRST, exactly as the summary and the smart pick ask it: an account
  // block's envelope still parses and still carries a `result` string, and that
  // string is a quota banner. Reading it as an answer would hand the banner's
  // words to a parser expecting titles — and count the block as a real pass.
  const limit = detectHeadlessLimit(run.stdout, run.stderr);
  const { usage, usd } = envelopeUsage(run.stdout);
  if (limit.blocked) {
    // The verb is the TASK's, because this sentence is shown to a person and
    // "nothing was titled" is not true of a commit message that was not written.
    return { text: "", failed: false, limited: true, detail: limitNote(limit, task === "commit" ? "written" : "titled"), usage, usd, durationMs: since() };
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
