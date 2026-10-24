/**
 * `claude-endpoint` — the real `claude` CLI pointed at ANY Anthropic-Messages
 * compatible URL: Ollama Cloud, an Ollama on a GPU box in the tailnet, a
 * LiteLLM proxy fronting Bedrock / Vertex / Azure open models.
 *
 * `claude-local`'s shape (`claude-local.ts`) with three differences: the URL
 * and model list come from configuration, a model is always `hosted` (it is
 * not on this disk, whatever the hostname says — a loopback LiteLLM still
 * forwards to somebody's cloud), and there may be an API KEY.
 *
 * ── The key never travels in argv, env, a log or the wire ──────────────────
 *
 * A launch's env reaches the tmux pane as `/usr/bin/env K=V …` ARGV
 * (`sessions/tmux.ts`), so a key there is readable by `ps` and by anyone
 * listing the pane's start command. Instead the CLI is handed Claude Code's
 * own `apiKeyHelper` setting — a COMMAND that prints the key — inside the
 * `--settings` blob the host already passes: `cat '<0600 file>'` or
 * `security find-generic-password -w -s '<service>'` (macOS keychain). The
 * argv holds a path or a service name, never the secret. Measured 2026-10-02
 * on 2.1.287: with `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` both set
 * EMPTY, the helper's output reached a stub endpoint as both `x-api-key` and
 * `Authorization: Bearer`, over a claude.ai login on the same machine.
 * `claudeendpoint.test.mjs` asserts no launch argv or env contains the key.
 *
 * With NO key configured the pane gets `ANTHROPIC_AUTH_TOKEN=none`, so the
 * person's own claude.ai credential is never sent to a third-party URL.
 *
 * **Listed, never hidden:** unconfigured, a key file other users can read, a
 * keychain entry that is not there, or an endpoint that answered no model list
 * — each is `unavailable: "<sentence>"`, and a key the host could not READ
 * (a keychain prompt nobody answered) is its own sentence, never blamed on
 * the endpoint.
 *
 * **Absent beats borrowed** for windows: only a configured `id=tokens`, or an
 * Ollama endpoint's own `/api/show`, ever names one.
 */
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { envName } from "@waterplane/shared";
import { env } from "../env.js";
import { ACCOUNTLESS_CLAUDE_FACTS, claudeBackend, CLAUDE_SPAWN_ENV } from "./claude.js";
import { leanArgs, windowFromShow } from "./claude-local.js";
import { measuredOverhead } from "./overhead.js";
import type { CoreBackendDescriptor, BackendModels, LaunchPlan, LaunchRequest } from "./types.js";
import { expandHome } from "../pathx.js";

/** Everything this backend is configured with — data, so a test pins it. */
export interface EndpointConfig {
  /** Base URL, trailing slashes removed. Empty = unconfigured. */
  readonly url: string;
  /** A static model list, in the order written; `null` = ask the endpoint. */
  readonly models: readonly string[] | null;
  /** Configured windows (`id=tokens`), positive only. */
  readonly windows: Readonly<Record<string, number>>;
  /** Where the key lives, if anywhere. */
  readonly key: { readonly kind: "file"; readonly path: string } | { readonly kind: "keychain"; readonly service: string } | null;
  /** Launch with the lean argv (`claude-local.ts`'s `leanArgs`). */
  readonly lean: boolean;
  /** The lean tool list, when lean. */
  readonly tools: string;
}

/**
 * Parse `WATERPLANE_CLAUDE_ENDPOINT_MODELS`: comma or whitespace separated,
 * each `id` or `id=tokens`. A window that is not a positive whole number is
 * dropped (the id is kept). Duplicates keep the first. Empty ⇒ null.
 */
export function parseModelList(raw: string | undefined): { ids: string[]; windows: Record<string, number> } | null {
  const ids: string[] = [];
  const windows: Record<string, number> = {};
  for (const part of (raw ?? "").split(/[,\s]+/)) {
    if (!part) continue;
    const eq = part.lastIndexOf("=");
    const id = eq > 0 ? part.slice(0, eq) : part;
    if (!id || ids.includes(id)) continue;
    ids.push(id);
    if (eq > 0) {
      const n = Number(part.slice(eq + 1));
      if (Number.isInteger(n) && n > 0) windows[id] = n;
    }
  }
  return ids.length ? { ids, windows } : null;
}

/** The configuration, read from the knobs at CALL time (a hot-reloaded `.env` is seen). */
export function endpointConfig(): EndpointConfig {
  const parsed = parseModelList(env("CLAUDE_ENDPOINT_MODELS"));
  // A leading `~/` is the home directory, as `.env.example` writes it; the CLI
  // runs the helper through a shell that would not expand it inside quotes.
  const raw = (env("CLAUDE_ENDPOINT_KEY_FILE") || "").trim();
  const file = raw.startsWith("~/") ? expandHome(raw) : raw;
  const service = (env("CLAUDE_ENDPOINT_KEYCHAIN") || "").trim();
  return {
    url: (env("CLAUDE_ENDPOINT_URL") || "").trim().replace(/\/+$/, ""),
    models: parsed?.ids ?? null,
    windows: parsed?.windows ?? {},
    key: file ? { kind: "file", path: file } : service ? { kind: "keychain", service } : null,
    lean: env("CLAUDE_ENDPOINT_LEAN") === "1",
    tools: env("CLAUDE_ENDPOINT_TOOLS") || "",
  };
}

/** POSIX single-quote one shell word. */
const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The `apiKeyHelper` COMMAND for a key source — it prints the key when the CLI
 * runs it; the string itself names only where the key lives. Null = no key.
 */
export function apiKeyHelperCommand(key: EndpointConfig["key"]): string | null {
  if (!key) return null;
  return key.kind === "file" ? `cat ${sq(key.path)}` : `security find-generic-password -w -s ${sq(key.service)}`;
}

/**
 * The environment a `claude-endpoint` pane gets — never the key. Both
 * credential variables are set EMPTY when a helper supplies the key (either one
 * set would win over the helper), and the auth token is a placeholder when
 * there is no key, so a claude.ai login is never sent to this URL.
 */
export function claudeEndpointEnv(cfg: EndpointConfig, window?: number | null): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: cfg.url,
    ANTHROPIC_AUTH_TOKEN: cfg.key ? "" : "none",
    ANTHROPIC_API_KEY: "",
    ...(window && window > 0 ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(Math.floor(window)) } : {}),
  };
}

/**
 * Merge keys into the JSON after `--settings` (the hook blob `claude.ts`
 * builds), leaving every other argument as it was. No `--settings` ⇒ one is
 * appended. Pure.
 */
export function withSettings(args: readonly string[], extra: Record<string, unknown>): string[] {
  const out = [...args];
  const at = out.indexOf("--settings");
  if (at >= 0 && at + 1 < out.length) {
    let base: Record<string, unknown> = {};
    try { base = JSON.parse(out[at + 1]) as Record<string, unknown>; } catch { /* not JSON: a path — leave it, add ours beside */ }
    if (Object.keys(base).length || out[at + 1].trim().startsWith("{")) {
      out[at + 1] = JSON.stringify({ ...base, ...extra });
      return out;
    }
  }
  out.push("--settings", JSON.stringify(extra));
  return out;
}

/** The last catalogue's windows, by id (`models()` fills it; config windows win). */
const measuredWindow = new Map<string, number>();

/** The argv + env for one launch. Exported so a test can assert the key is nowhere in it. */
export function endpointLaunch(req: LaunchRequest, cfg: EndpointConfig = endpointConfig()): LaunchPlan {
  if (!cfg.url) {
    throw new Error(`Claude Code on a custom endpoint is not configured on this desktop — set ${envName("CLAUDE_ENDPOINT_URL")} (see .env.example).`);
  }
  if (!req.launch.model) {
    throw new Error(`Claude on a custom endpoint needs a model chosen first — pick one of the models ${cfg.url} offers.`);
  }
  const base = claudeBackend.prepare(req);
  const helper = apiKeyHelperCommand(cfg.key);
  let args = helper ? withSettings(base.args, { apiKeyHelper: helper }) : [...base.args];
  if (cfg.lean) args = [...args, ...leanArgs({ lean: true, tools: cfg.tools })];
  const window = cfg.windows[req.launch.model] ?? measuredWindow.get(req.launch.model) ?? null;
  return { ...base, args, env: claudeEndpointEnv(cfg, window) };
}

/**
 * Why the configured key cannot be used, as a sentence; null when it can.
 * A file must exist, be a regular non-empty file, and be readable by its owner
 * only — a key other users can read is refused rather than used. Never reads
 * the key into anything but the caller's own memory.
 */
export async function keyProblem(key: EndpointConfig["key"], deps: { platform?: string; keychainHas?: (svc: string) => Promise<boolean> } = {}): Promise<string | null> {
  if (!key) return null;
  if (key.kind === "file") {
    let s;
    try { s = await stat(key.path); } catch { return `The key file ${key.path} does not exist.`; }
    if (!s.isFile()) return `The key file ${key.path} is not a file.`;
    if ((s.mode & 0o077) !== 0) return `The key file ${key.path} can be read by other users (mode ${(s.mode & 0o777).toString(8)}); chmod 600 it.`;
    if (s.size === 0) return `The key file ${key.path} is empty.`;
    return null;
  }
  if ((deps.platform ?? process.platform) !== "darwin") return `A keychain key (${envName("CLAUDE_ENDPOINT_KEYCHAIN")}) needs macOS; use ${envName("CLAUDE_ENDPOINT_KEY_FILE")} here.`;
  const has = await (deps.keychainHas ?? keychainHas)(key.service);
  return has ? null : `The macOS keychain has no generic password for service "${key.service}".`;
}

/** Does the login keychain hold this service? Asked WITHOUT `-w`, so the secret is never printed. */
function keychainHas(service: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("security", ["find-generic-password", "-s", service], { timeout: 5000 }, (err) => resolve(!err));
  });
}

/** Why the host could not read the key for its own catalogue request — a
 *  sentence naming the KEY READ, so a keychain that never answered is not
 *  blamed on the endpoint. */
export interface KeyReadProblem { readonly problem: string }

const KEYCHAIN_TIMEOUT_MS = 5000;

/**
 * The key itself, for the HOST's own catalogue request only, or a sentence
 * saying why it could not be read. A launchd daemon asking the keychain with
 * `-w` may raise a GUI permission prompt nobody sees; that is a 5 s TIMEOUT
 * here, and the sentence says so rather than reaching the endpoint keyless and
 * reporting its 401 as "did not answer".
 */
async function readKey(key: EndpointConfig["key"]): Promise<string | KeyReadProblem | null> {
  if (!key) return null;
  if (key.kind === "file") {
    try {
      return (await readFile(key.path, "utf8")).trim() || { problem: `The key file ${key.path} is empty.` };
    } catch (e) {
      return { problem: `The key file ${key.path} could not be read (${(e as NodeJS.ErrnoException)?.code ?? "failed"}).` };
    }
  }
  return new Promise((resolve) => {
    execFile("security", ["find-generic-password", "-w", "-s", key.service], { timeout: KEYCHAIN_TIMEOUT_MS }, (err, out) => {
      if (!err) { resolve(String(out).trim() || { problem: `The macOS keychain entry "${key.service}" is empty.` }); return; }
      resolve({ problem: keychainReadProblem(key.service, err as { killed?: boolean; signal?: string | null; code?: unknown }) });
    });
  });
}

/** The sentence for a failed `security … -w` read. Pure; exported for tests. */
export function keychainReadProblem(service: string, err: { killed?: boolean; signal?: string | null; code?: unknown }): string {
  if (err.killed || err.signal) {
    return `Reading the key for "${service}" from the macOS keychain did not finish within ${KEYCHAIN_TIMEOUT_MS / 1000} s — the keychain is probably waiting on a permission prompt this background daemon cannot show. Allow access once ("Always Allow" for /usr/bin/security), or use ${envName("CLAUDE_ENDPOINT_KEY_FILE")}. The endpoint was not asked.`;
  }
  return `Reading the key for "${service}" from the macOS keychain failed (security exited ${typeof err.code === "number" ? err.code : "with an error"}) — access may have been denied. The endpoint was not asked.`;
}

/**
 * Model ids out of a catalogue document: Ollama's `/api/tags`
 * (`models[].name`) or the OpenAI/Anthropic `/v1/models` (`data[].id`).
 * Anything else ⇒ null (not "no models"). Pure.
 */
export function idsFromCatalogue(doc: unknown): string[] | null {
  const d = doc as { models?: unknown; data?: unknown } | null;
  if (!d || typeof d !== "object") return null;
  const list = Array.isArray(d.models) ? d.models.map((m) => (m as { name?: unknown })?.name)
    : Array.isArray(d.data) ? d.data.map((m) => (m as { id?: unknown })?.id)
    : null;
  if (!list) return null;
  const ids = list.filter((x): x is string => typeof x === "string" && x !== "");
  return [...new Set(ids)];
}

async function getJson(url: string, key: string | null, init?: RequestInit): Promise<unknown> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (key) { headers.authorization = `Bearer ${key}`; headers["x-api-key"] = key; headers["anthropic-version"] = "2023-06-01"; }
  const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Ask the endpoint which models it serves, and (Ollama only) their windows. Throws a short reason. */
async function askCatalogue(url: string, key: string | null): Promise<{ ids: string[]; windows: Record<string, number> }> {
  const reasons: string[] = [];
  try {
    const ids = idsFromCatalogue(await getJson(`${url}/api/tags`, key));
    if (ids?.length) {
      const windows: Record<string, number> = {};
      await Promise.all(ids.map(async (id) => {
        try {
          const w = windowFromShow(await getJson(`${url}/api/show`, key, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: id }),
          }));
          if (w) windows[id] = w;
        } catch { /* unmeasured: the id stays, its window is absent */ }
      }));
      return { ids, windows };
    }
    reasons.push("/api/tags listed no models");
  } catch (e) { reasons.push(`/api/tags: ${e instanceof Error ? e.message : "failed"}`); }
  try {
    const ids = idsFromCatalogue(await getJson(`${url}/v1/models`, key));
    if (ids?.length) return { ids, windows: {} };
    reasons.push("/v1/models listed no models");
  } catch (e) { reasons.push(`/v1/models: ${e instanceof Error ? e.message : "failed"}`); }
  throw new Error(reasons.join("; "));
}

/** The catalogue, given a config and the two outside reads. Exported for tests. */
export async function endpointModels(cfg: EndpointConfig, deps: {
  keyProblem?: typeof keyProblem; readKey?: typeof readKey; overhead?: typeof measuredOverhead;
} = {}): Promise<BackendModels> {
  if (!cfg.url) {
    return { aliases: [], ids: [], unavailable: `Not configured on this desktop: set ${envName("CLAUDE_ENDPOINT_URL")} (and a key, a model list) — see .env.example.` };
  }
  const problem = await (deps.keyProblem ?? keyProblem)(cfg.key);
  if (problem) return { aliases: [], ids: [], unavailable: problem };
  let ids: string[];
  let windows: Record<string, number>;
  if (cfg.models) {
    ids = [...cfg.models];
    windows = { ...cfg.windows };
  } else {
    const key = await (deps.readKey ?? readKey)(cfg.key);
    // The KEY READ failed: say that, never "the endpoint did not answer".
    if (key && typeof key === "object") return { aliases: [], ids: [], unavailable: key.problem };
    try {
      const got = await askCatalogue(cfg.url, key);
      ids = got.ids;
      windows = got.windows;
    } catch (e) {
      return {
        aliases: [], ids: [],
        unavailable: `${cfg.url} did not answer a model list (${e instanceof Error ? e.message : "failed"}). Name the models in ${envName("CLAUDE_ENDPOINT_MODELS")}.`,
      };
    }
  }
  measuredWindow.clear();
  for (const [id, w] of Object.entries(windows)) measuredWindow.set(id, w);
  const where: Record<string, "hosted"> = {};
  for (const id of ids) where[id] = "hosted";
  const overheadTok = await (deps.overhead ?? measuredOverhead)(ids);
  return {
    aliases: [], ids, where,
    contextWindow: windows,
    ...(Object.keys(overheadTok).length ? { overheadTok } : {}),
  };
}

export const claudeEndpointBackend: CoreBackendDescriptor = {
  ...claudeBackend,
  id: "claude-endpoint",
  label: "Claude Code (custom endpoint)",
  spawnEnv: CLAUDE_SPAWN_ENV,
  prepare: (req) => endpointLaunch(req),
  caps: {
    ...claudeBackend.caps,
    remoteControl: false,
  },
  // An account's limits and usage report are claude.ai's; this is someone else's endpoint.
  // (no gauge, no limit wall, no usage probe: those three providers are dropped).
  facts: ACCOUNTLESS_CLAUDE_FACTS,
  models: () => endpointModels(endpointConfig()),
  healthScope: false,
};
