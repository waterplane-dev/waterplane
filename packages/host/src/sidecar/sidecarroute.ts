/**
 * The route slice of `sidecar.ts` — see that file's header for the seam's rules.
 */
import { BRAND, resolveEnv } from "@waterplane/shared";

/** The unattended calls this daemon makes, one routing knob each. */
export type SidecarTask = "summary" | "assess" | "review" | "smartpick" | "name" | "commit";

/** How a completion is obtained. */
export type SidecarEngine = "claude-p" | "openai-compat";

/** The environment variable that routes each task. */
export const SIDECAR_ENV: Readonly<Record<SidecarTask, string>> = {
  summary: `${BRAND.envPrefix}SIDECAR_SUMMARY`,
  assess: `${BRAND.envPrefix}SIDECAR_ASSESS`,
  review: `${BRAND.envPrefix}SIDECAR_REVIEW`,
  smartpick: `${BRAND.envPrefix}SIDECAR_SMARTPICK`,
  name: `${BRAND.envPrefix}SIDECAR_NAME`,
  commit: `${BRAND.envPrefix}SIDECAR_COMMIT`,
};

/**
 * Does this task's contract need TOOLS?
 *
 * The one fact that decides whether the toolless local engine is even
 * admissible. `summary` is false by construction — see the header.
 *
 * `smartpick` is false for exactly the summary's reason and no weaker one: the
 * backlog items it grooms and the repo facts it grooms them against are IN the
 * prompt. It never reads a file, never opens the repo, and is forbidden from
 * typing into a session at all.
 */
const NEEDS_TOOLS: Readonly<Record<SidecarTask, boolean>> = {
  summary: false,
  assess: true,
  review: true,
  smartpick: false,
  // `name` is on the summary's side of the line and for the summary's reason,
  // not a weaker one: a naming pass is handed the items' own words and is asked
  // what to CALL them. It opens no file, runs no git, and could not use a tool
  // if it had one — the answer is a title for a sentence that is already in the
  // prompt. It is also the cheapest task here, so it is the one most worth
  // being able to move off the account entirely.
  name: false,
  // `commit` is on the same side of the line, and the reason is the same one
  // stated three times above: the diff, the file list and the repo's own recent
  // subjects are IN the prompt. It runs no git of its own, opens no file, and
  // writes nothing — the answer is a sentence a person then reads, edits and
  // commits by hand.
  commit: false,
};

export interface ClaudeRoute { readonly engine: "claude-p" }
export interface OpenAIRoute {
  readonly engine: "openai-compat";
  /** Server base, no trailing slash. `/chat/completions` is appended. */
  readonly baseURL: string;
  readonly model: string;
}
/** A route that will not be taken, and the sentence saying why. */
export interface RefusedRoute { readonly engine: "refused"; readonly reason: string }
export type SidecarPlan = ClaudeRoute | OpenAIRoute | RefusedRoute;

// ── Routing ────────────────────────────────────────────────────────────────

/**
 * Parse one routing spec.
 *
 * Grammar — `.env.example` is authoritative, this is the implementation of it:
 *
 * ```
 *   spec   := "claude" | "claude-p" | "openai-compat:" target
 *   target := <baseURL> "|" <model>        (exact — use this one)
 *           | <baseURL> ":" <model>        (accepted where it cannot mis-split)
 * ```
 *
 * **Why a pipe.** The obvious `openai-compat:<baseURL>:<model>` is ambiguous
 * against real values: the URL carries a colon in its scheme AND its port
 * (`http://localhost:11434/v1`) and the model carries one in its tag
 * (`gemma4:e4b`), so there is no colon a splitter can point at and be right.
 * `|` cannot appear unescaped in a URL and does not appear in a model tag, so
 * splitting on the first one is exact.
 *
 * The colon form is still accepted, because it is what a person will type, but
 * ONLY in the shape where it is decidable: the URL must have a path, and the
 * split is the first colon AFTER the start of that path. That reads
 * `http://localhost:11434/v1:gemma4:e4b` correctly (base `…/v1`, model
 * `gemma4:e4b`) and REFUSES `http://localhost:11434:model`, which could equally
 * mean a port or a model. One residual: a URL whose PATH contains a colon
 * before the model would split early — it then fails as a bad base URL and
 * yields no completion, never a wrong one, and the pipe form is the fix.
 *
 * Anything unrecognised is REFUSED with a sentence. It is never silently
 * treated as `claude`: the whole reason to set this knob is to stop a call
 * going to Anthropic, so a typo that quietly sent it there anyway would defeat
 * the only thing it was for.
 */
export function parseSidecarSpec(raw: string | undefined | null, envName = "the sidecar route"): SidecarPlan {
  const spec = (raw ?? "").trim();
  if (!spec) return { engine: "claude-p" };
  const lower = spec.toLowerCase();
  if (lower === "claude" || lower === "claude-p") return { engine: "claude-p" };

  const PREFIX = "openai-compat";
  if (!lower.startsWith(PREFIX)) {
    return { engine: "refused", reason: `${envName} is set to "${spec}", which is not an engine this host knows. It can run: claude, openai-compat:<baseURL>|<model>.` };
  }
  const sep = spec.slice(PREFIX.length, PREFIX.length + 1);
  const target = spec.slice(PREFIX.length + 1);
  if (sep !== ":" || !target) {
    return { engine: "refused", reason: `${envName} is set to "${spec}", which names the openai-compat engine but no server. Write it as openai-compat:<baseURL>|<model>, e.g. openai-compat:http://localhost:11434/v1|gemma4:e4b.` };
  }

  let rawBase: string;
  let model: string;
  const pipe = target.indexOf("|");
  if (pipe >= 0) {
    rawBase = target.slice(0, pipe);
    model = target.slice(pipe + 1);
  } else {
    // Colon form: find where the URL's PATH begins, then split at the first
    // colon after it. Before that point every colon belongs to the scheme or
    // the port, and guessing between them is the mis-split this refuses.
    const schemeAt = target.indexOf("://");
    const pathAt = schemeAt >= 0 ? target.indexOf("/", schemeAt + 3) : target.indexOf("/");
    const at = pathAt >= 0 ? target.indexOf(":", pathAt) : -1;
    if (at < 0) {
      return { engine: "refused", reason: `${envName} is set to "${spec}", and where the server URL ends and the model begins cannot be told apart. Separate them with a pipe: openai-compat:<baseURL>|<model>.` };
    }
    rawBase = target.slice(0, at);
    model = target.slice(at + 1);
  }

  rawBase = rawBase.trim().replace(/\/+$/, "");
  model = model.trim();
  if (!model) {
    return { engine: "refused", reason: `${envName} is set to "${spec}" and names no model. Write it as openai-compat:<baseURL>|<model>.` };
  }
  let parsed: URL;
  try { parsed = new URL(rawBase); } catch {
    return { engine: "refused", reason: `${envName} is set to "${spec}" and "${rawBase}" is not a URL. Write it as openai-compat:<baseURL>|<model>, e.g. openai-compat:http://localhost:11434/v1|gemma4:e4b.` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { engine: "refused", reason: `${envName} is set to "${spec}" and "${rawBase}" is not an http(s) URL.` };
  }
  return { engine: "openai-compat", baseURL: rawBase, model };
}

/**
 * The route one task will take, from the environment.
 *
 * Also where a task whose contract needs tools refuses the toolless engine —
 * in words naming the variable, because the person who set it is the only one
 * who can unset it.
 */
export function sidecarPlan(task: SidecarTask, env: NodeJS.ProcessEnv = process.env): SidecarPlan {
  const name = SIDECAR_ENV[task];
  const plan = parseSidecarSpec(resolveEnv(env, name.slice(BRAND.envPrefix.length)).value, name);
  if (plan.engine === "openai-compat" && NEEDS_TOOLS[task]) {
    return {
      engine: "refused",
      reason: `${name} is set to the openai-compat engine, which runs one completion with no tools. The ${task} task has to read the repo (and write its files), so it cannot run that way and nothing was run. Unset ${name} to run it on claude.`,
    };
  }
  return plan;
}

/**
 * Say a refusal once.
 *
 * A misrouted task refuses on every single fire — one per turn-end per session
 * for the summary — and a line per fire is a log nobody reads. The reason is
 * the same sentence every time, so the first one is the whole message.
 */
const said = new Set<string>();
export function sayOnce(reason: string): void {
  if (said.has(reason)) return;
  said.add(reason);
  console.warn(`[sidecar] ${reason}`);
}

/** Test seam: forget what has been said, so a case can assert it is said. */
export function resetSidecarWarnings(): void { said.clear(); }
