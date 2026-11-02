/**
 * `claude-local` — the real `claude` CLI, pointed at a local Ollama.
 *
 * Ollama answers Anthropic-shaped `/v1/messages`, so the binary, its TUI, its
 * hooks, its jsonl and its choice boxes are all claude's: this descriptor is
 * `claudeBackend` with four changes (`docs/analysis/backends-design.md` §7):
 * the launch ENVIRONMENT, a model that must be named, a catalogue read from
 * Ollama, and the capabilities that are about an ACCOUNT (usage limits, the
 * usage report) switched off.
 *
 * **Absent beats borrowed.** The window comes from Ollama — a LOADED runner's
 * `/api/ps` `context_length` first (what it really allocated: a Modelfile without
 * `num_ctx` gets a memory-chosen default on Ollama 0.3x+), else `/api/show`'s
 * `num_ctx`, else the model's `context_length`; a 0 or a failure is ABSENT,
 * never claude's table (`isClaudeModel` already refuses a non-claude id there).
 * Cost is absent because `pricing.ts` prices only `claude-*` ids. The CLI's own
 * gauge is OFF (`contextMeter:false`) unless the probe proved it prints the
 * right percentage for a local model — see `docs/analysis/spikes/`.
 *
 * The same measured window is handed to the CLI as `CLAUDE_CODE_MAX_CONTEXT_TOKENS`:
 * a model id claude's catalogue does not know is otherwise assumed to hold 200k,
 * so auto-compact would wait past a 64k Ollama window and the runner would cut
 * the prompt silently. Unmeasured ⇒ the variable is left out (claude's own
 * warning on screen says so), never a guess.
 *
 * **Listed, never hidden, when Ollama is down:** `models()` then answers an
 * empty catalogue with `unavailable: "Ollama not reachable at <url>"`.
 *
 * **LEAN by default** (`WATERPLANE_CLAUDE_LOCAL_LEAN`, `leanArgs`): measured
 * 2026-10-02 (`docs/analysis/spikes/2026-10-02-claude-local-lean.md`), the
 * full built-in tool set is ~27k of the ~32k Claude Code sends before the
 * first word — half a 64k window, and 65 s of prefill per turn on a resident
 * model. `--tools Read,Edit,Write,Bash,Grep,Glob` keeps a working coding agent
 * at ~5.7k and ~6 s. **WARM** (`WATERPLANE_CLAUDE_LOCAL_KEEP_ALIVE`): a launch
 * asks Ollama to load the model now, fire-and-forget, so the cold load
 * overlaps the person typing. The catalogue also carries the MEASURED overhead
 * per model (`overhead.ts`) for the picker's window sentence.
 */
import { env } from "../env.js";
import { ollamaUrl, warmLocalModel } from "../localrt.js";
import { ACCOUNTLESS_CLAUDE_FACTS, claudeBackend, CLAUDE_SPAWN_ENV } from "./claude.js";
import { measuredOverhead } from "./overhead.js";
import type { CoreBackendDescriptor, BackendModels, LaunchPlan, LaunchRequest } from "./types.js";

/**
 * The built-in tools a lean launch keeps: enough to read, change and run a repo — and `Skill`,
 * because a repo whose CLAUDE.md routes its rules into `.claude/skills` ("load `web` before
 * editing packages/web") is otherwise told to load something it has no tool for, and the
 * rules in those skills never reach the model. Measured 2026-10-31: +1.8k chars of schema and
 * the skill listing (~6.8k chars here) — ~2.4k tokens, against the 27k the full set costs.
 */
export const LEAN_TOOLS = "Read,Edit,Write,Bash,Grep,Glob,Skill";

/**
 * The argv a lean launch appends to claude's. Data, pinned byte for byte.
 *
 *  - `--tools <list>` — the one that matters: every built-in tool's schema
 *    (Task, the web tools, notebooks, todos, plan mode, Skill, …) rides in
 *    every request. Measured: 32,392 → 5,661 input tokens on the first request.
 *  - `--strict-mcp-config` with no `--mcp-config` — no MCP server's tools
 *    either. Measured no change in a directory with none configured; a repo's
 *    `.mcp.json` would otherwise add its schemas to every turn.
 *
 * Not used, measured: `--disable-slash-commands` (no change once `--tools`
 * dropped the Skill tool) and `--setting-sources project,local` (−1k, but it
 * drops the person's own permissions and settings — not this app's to drop).
 * `tools` empty ⇒ `LEAN_TOOLS`. `lean: false` ⇒ nothing.
 */
export function leanArgs(opts: { lean: boolean; tools?: string }): string[] {
  if (!opts.lean) return [];
  const tools = (opts.tools ?? "").split(/[,\s]+/).filter(Boolean).join(",") || LEAN_TOOLS;
  return ["--tools", tools, "--strict-mcp-config"];
}

/**
 * `--setting-sources project,local` unless the person keeps their USER settings for local
 * sessions (`WATERPLANE_CLAUDE_LOCAL_USER_SETTINGS=1`; default since 2026-10-31: dropped, the owner's
 * call after the benchmark below). Measured 2026-10-31: a
 * user-level SessionStart/UserPromptSubmit hook that injects context ("respond terse…") on every
 * prompt took a local 8B model over entirely — it answered the hook ("Mode active. Ready.") and
 * never the task. Off, the user file's hooks, plugins, env AND permissions are all dropped
 * (the host's own hooks ride `--settings` and stay). Claude Code cannot drop one hook alone, and
 * `disableAllHooks` would silence the host's own, so the whole user file is the only lever.
 */
export function userSettingsArgs(keep: boolean): string[] {
  return keep ? [] : ["--setting-sources", "project,local"];
}

/** The lean argv as this desktop is configured (`WATERPLANE_CLAUDE_LOCAL_LEAN`, default on; `_TOOLS`; `_USER_SETTINGS`). */
export function claudeLocalLeanArgs(): string[] {
  return [
    ...leanArgs({ lean: env("CLAUDE_LOCAL_LEAN") !== "0", tools: env("CLAUDE_LOCAL_TOOLS") || "" }),
    ...userSettingsArgs(env("CLAUDE_LOCAL_USER_SETTINGS") === "1"),
  ];
}

/**
 * How long a launch asks Ollama to keep the model loaded
 * (`WATERPLANE_CLAUDE_LOCAL_KEEP_ALIVE`, default `30m`); null = do not warm.
 * `off`, `no`, `false`, `0` and blank switch it off (`0` would UNLOAD it).
 * Spelled as Ollama spells it (`30m`, `1h`, `-1` for ever, whole seconds);
 * anything else falls back to the default rather than being sent.
 */
export function claudeLocalKeepAlive(raw: string | undefined = env("CLAUDE_LOCAL_KEEP_ALIVE")): string | null {
  if (raw === undefined) return "30m";
  const v = raw.trim();
  if (!v || /^(off|no|false|0)$/i.test(v)) return null;
  return /^-1$|^\d+$|^\d+(\.\d+)?(s|m|h)$/.test(v) ? v : "30m";
}

/** The warm ping, replaceable so a test never loads a real 18 GB model. */
export const warmDeps = { warm: (model: string, keepAlive: string): Promise<unknown> => warmLocalModel(model, keepAlive) };

/** Where Ollama is — the same knob the local-runtime strip uses (`WATERPLANE_OLLAMA_URL`). */
export const claudeLocalUrl = (): string => ollamaUrl();

/** The windows the last catalogue read measured, by model id (`models()` fills it). */
const measuredWindow = new Map<string, number>();

/**
 * The environment a `claude-local` pane gets. Data, so a test pins it byte for
 * byte. `window` is Ollama's measured window for the model, when there is one.
 */
export function claudeLocalEnv(window?: number | null): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: claudeLocalUrl(),
    ANTHROPIC_AUTH_TOKEN: "ollama",
    ANTHROPIC_API_KEY: "",
    ...(window && window > 0 ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(Math.floor(window)) } : {}),
  };
}

function prepare(req: LaunchRequest): LaunchPlan {
  // Without --model the CLI asks for its own default (a `claude-*` id) and
  // Ollama answers not_found_error minutes into the first turn. Refuse here.
  if (!req.launch.model) {
    throw new Error(`Claude on a local model needs a model chosen first — pick one of the models Ollama has at ${claudeLocalUrl()}.`);
  }
  const base = claudeBackend.prepare(req);
  const window = measuredWindow.get(req.launch.model);
  // A model pulled or created after the host booted was never measured (the catalogue is asked
  // at boot, and again only while it says unavailable): this launch goes without the variable —
  // the CLI then assumes 200k and compacts too late for a 64k runner — so measure it now, for the
  // next one. Never awaited: a core plan is decided synchronously.
  if (!window) void measureDeps.measure(req.launch.model).catch(() => undefined);
  const keepAlive = claudeLocalKeepAlive();
  // Never awaited, never thrown: a launch does not wait on the runner.
  if (keepAlive) void Promise.resolve().then(() => warmDeps.warm(req.launch.model!, keepAlive)).catch(() => undefined);
  return { ...base, args: [...base.args, ...claudeLocalLeanArgs()], env: claudeLocalEnv(window) };
}

/**
 * The window Ollama gives a model, from an `/api/show` document. `num_ctx` in
 * the Modelfile `parameters` text wins (it is what the runner actually
 * allocates); else the architecture's `context_length`. 0, negative, NaN or
 * missing ⇒ null. Pure, so it is pinned without a server.
 */
export function windowFromShow(doc: unknown): number | null {
  const d = doc as { parameters?: unknown; model_info?: Record<string, unknown> } | null;
  if (!d || typeof d !== "object") return null;
  if (typeof d.parameters === "string") {
    const m = /^\s*num_ctx\s+(\d+)\s*$/m.exec(d.parameters);
    if (m) {
      const n = Number(m[1]);
      if (n > 0) return n;
      // num_ctx 0 is "not set", not a window — fall through to context_length.
    }
  }
  const info = d.model_info;
  if (info && typeof info === "object") {
    for (const [k, v] of Object.entries(info)) {
      if (/\.context_length$/.test(k) && typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
    }
  }
  return null;
}

/**
 * The window a LOADED runner has, from an `/api/ps` document: its `context_length` for exactly
 * this model name (`name` or `model`, with or without `:latest`). That is what the runner
 * allocated — on Ollama 0.3x+ a Modelfile without `num_ctx` gets a default chosen by the
 * machine's memory (4k on a small one, the model's whole window on a big one), so for a loaded
 * model this beats both `num_ctx` and `context_length`. Not loaded, 0 or missing ⇒ null.
 */
export function windowFromPs(doc: unknown, model: string): number | null {
  const list = (doc as { models?: unknown } | null)?.models;
  if (!Array.isArray(list)) return null;
  const bare = (n: unknown): string => (typeof n === "string" ? n.replace(/:latest$/, "") : "");
  const want = bare(model);
  for (const m of list as Array<{ name?: unknown; model?: unknown; context_length?: unknown }>) {
    if (bare(m?.name) !== want && bare(m?.model) !== want) continue;
    const n = m.context_length;
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  }
  return null;
}

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** `/api/show` for one model, or null — unmeasured is kept: the id stays, the window is absent. */
async function showOf(url: string, name: string): Promise<unknown> {
  try {
    return await getJson(`${url}/api/show`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: name }),
    });
  } catch { return null; }
}

/** Measure ONE model's window into the launch cache (a model the boot-time catalogue never saw). */
async function measureOne(model: string): Promise<number | null> {
  const url = claudeLocalUrl();
  const ps = await getJson(`${url}/api/ps`).catch(() => null);
  const w = windowFromPs(ps, model) ?? windowFromShow(await showOf(url, model));
  if (w) measuredWindow.set(model, w);
  return w;
}

/** Replaceable so a test measures without a server. */
export const measureDeps = { measure: (model: string): Promise<number | null> => measureOne(model) };

/** The window the launch cache holds for a model (tests read it). */
export const measuredWindowOf = (model: string): number | undefined => measuredWindow.get(model);

async function models(): Promise<BackendModels> {
  const url = claudeLocalUrl();
  let names: string[];
  try {
    const tags = (await getJson(`${url}/api/tags`)) as { models?: Array<{ name?: unknown }> };
    names = (tags.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === "string" && n !== "");
  } catch {
    return { aliases: [], ids: [], unavailable: `Ollama not reachable at ${url}` };
  }
  const kept = new Map<string, number | null>();
  const ps = await getJson(`${url}/api/ps`).catch(() => null);
  await Promise.all(names.map(async (name) => {
    const show = await showOf(url, name);
    const caps = (show as { capabilities?: unknown } | null)?.capabilities;
    // An embedding model cannot chat. Judged only on Ollama's OWN capability list; unmeasured is kept.
    if (Array.isArray(caps) && !caps.includes("completion")) return;
    kept.set(name, windowFromPs(ps, name) ?? windowFromShow(show));
  }));
  const ids = names.filter((n) => kept.has(n));
  const contextWindow: Record<string, number> = {};
  for (const id of ids) { const w = kept.get(id); if (w) contextWindow[id] = w; }
  measuredWindow.clear();
  for (const [id, w] of Object.entries(contextWindow)) measuredWindow.set(id, w);
  // Loopback is local; anything else is hosted — parsed, never substring-matched.
  let host = "";
  try { host = new URL(url).hostname; } catch { /* leave unknown */ }
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  const where: Record<string, "local" | "hosted"> = {};
  if (host) for (const id of ids) where[id] = local ? "local" : "hosted";
  const overheadTok = await measuredOverhead(ids);
  return {
    aliases: [], ids,
    ...(host ? { where } : {}),
    ...(Object.keys(overheadTok).length ? { overheadTok } : {}),
    // Runs on this machine: no money changes hands. Only measured for loopback.
    ...(local ? { zeroCost: [...ids] } : {}),
    contextWindow,
  };
}

export const claudeLocalBackend: CoreBackendDescriptor = {
  ...claudeBackend,
  id: "claude-local",
  label: "Claude Code (local model)",
  spawnEnv: CLAUDE_SPAWN_ENV,
  prepare,
  caps: {
    ...claudeBackend.caps,
    remoteControl: false,
  },
  // The CLI's gauge assumes a window for the model id; the probe spike records what it printed.
  // (no gauge, no limit wall, no usage probe: those three providers are dropped).
  facts: ACCOUNTLESS_CLAUDE_FACTS,
  models,
  localRunner: "ollama",
  healthScope: false,
};
