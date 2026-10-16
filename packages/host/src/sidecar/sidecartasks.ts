/**
 * The tasks slice of `sidecar.ts` — see that file's header for the seam's rules.
 */
import { detectHeadlessLimit } from "../limit.js";
import { sayOnce, sidecarPlan } from "./sidecarroute.js";
import { runHeadlessClaude } from "./sidecarclaude.js";
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
