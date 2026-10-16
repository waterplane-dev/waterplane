/**
 * The local-model gate: how many coding sessions on a LOCAL model may be
 * working at once, and making sure the model is loaded before an automatic
 * item opens on it.
 *
 * The owner's rule (2026-10-13, R-intent-local-001): "the model must be loaded
 * and aligned with other agents that use local ai — only one active coding
 * session at a time for local ai as default, but the user needs a setting to
 * change this." Reasoning: docs/notes/host.md, "The local-model gate".
 *
 * - **Locality is a backend's fact, never an id string.** A descriptor with a
 *   `localRunner` ("ollama": `claude-local`) is local exactly when that runner's
 *   URL is loopback; any other backend is local for a model its own catalogue
 *   placed `where: "local"` (opencode's local providers). Unknown is NOT local.
 * - **"Active" is a turn running** (`SessionInfo.turnActive`), plus every
 *   local row `starting`/`running` (the window between the spawn and the first
 *   `UserPromptSubmit`, and a chain between its turns). An idle local session
 *   that is merely open holds nothing — the owner said "active coding session".
 * - **Automatic starts WAIT** (`localModel`, rung 4.55 of `intentVerdict`); a
 *   person's own start is TOLD (`localSlotOverText`) and never refused.
 * - **The cap** is the synced `waterplane.local.maxSessions`
 *   (`localSessionsSetting`), else `WATERPLANE_LOCAL_SESSIONS`, else 1; `0` = no cap.
 * - **Loading** happens only for a backend with a `localRunner` (Ollama is the
 *   one runner this host can ask). Unreachable, a model the runner does not
 *   have, or a load that runs past `LOAD_TIMEOUT_MS` keeps the row HELD with
 *   that sentence and retries after `RETRY_MS` — never a silent fail, never a
 *   fall back to another model.
 * - **Sidecar calls** (`sidecaropenai.ts`) to the same runner skip — the empty
 *   result every caller already reads as "no answer" — while a local coding
 *   turn is working on a DIFFERENT model (`localSwapGuard`): a summary must not
 *   evict the model an agent is mid-turn on. Same model, or nothing working,
 *   goes ahead; sidecar calls never count against the cap (they are seconds).
 *
 * Installed once at boot (`installLocalSlots`, `main.ts`), `localrt.ts`'s
 * arrangement: this module has no `HostCtx`, and unset is "nobody said" —
 * every reader answers absent and the ladder skips the rung.
 */
import {
  localSessionsSetting,
  localSlotOverText,
  localSlotWaitText,
  modelBaseName,
  ORIGIN_FANOUT_TARGET,
  type Intent,
  type IntentFacts,
  type LocalSlotFacts,
} from "@waterplane/shared";
import { backendModelWhere, resolveBackend } from "./backends/index.js";
import { claudeLocalKeepAlive } from "./backends/claude-local.js";
import { env } from "./env.js";
import { loadLocalModel, ollamaUrl, type LocalLoadFailure } from "./localrt.js";

// ── Locality ────────────────────────────────────────────────────────────────

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Is this URL on this machine? Parsed, never substring-matched. */
export function isLoopbackUrl(url: string): boolean {
  try { return LOOPBACK.has(new URL(url).hostname); } catch { return false; }
}

/** The runner a backend always runs on, or null (`BackendDescriptor.localRunner`). */
function runnerOf(backendId: string | undefined): "ollama" | null {
  try { return resolveBackend(backendId).localRunner ?? null; } catch { return null; }
}

/**
 * Does a session launched on (`backend`, `model`) run on THIS desktop's local
 * runner? False when nobody can say — unknown is never local, so the cap can
 * only ever hold a session that is known to compete for the local model.
 */
export function isLocalLaunch(backendId: string | undefined, model: string | undefined): boolean {
  if (runnerOf(backendId) === "ollama") return !!model && isLoopbackUrl(ollamaUrl());
  return backendModelWhere(backendId, model) === "local";
}

// ── The facts, pure ─────────────────────────────────────────────────────────

/** What the gate reads of a live session. */
export interface LocalSessionView {
  id: string;
  running: boolean;
  backend?: string;
  model?: string;
  turnActive?: boolean;
  /** What a sentence calls it (`waitedSessionName`). */
  name?: string;
}

/** The inputs of one reading — every one of them the host's own fact. */
export interface LocalSlotInput {
  /** `null` = no cap. */
  max: number | null;
  sessions: readonly LocalSessionView[];
  rows: readonly Intent[];
  isLocal: (backend: string | undefined, model: string | undefined) => boolean;
}

/** The (backend, model) a row's run starts a turn on, or null when it opens nothing local. */
function rowRunsOn(i: Intent, byId: Map<string, LocalSessionView>): { backend?: string; model?: string } | null {
  if (i.payload.kind !== "prompt") return null;
  if (i.target.kind === "session") {
    const s = byId.get(i.target.sessionId);
    // A target that is gone reopens its conversation on the row's own launch.
    if (s?.running) return { backend: s.backend, model: s.model };
  }
  // A sweep is gated per TARGET (each one is its own fresh row); a fan-out
  // follow-up re-drives sessions the sweep already counted; a shell has no model.
  if (i.target.kind === "shell" || i.target.kind === "repos" || i.target.kind === "sessions") return null;
  return { backend: i.launch?.backend, model: i.launch?.model };
}

/**
 * One reading of the local cap: the sentence's facts (`working`, oldest
 * first) and the ladder's (`IntentFacts.local`). `exclude` leaves out one
 * session and one row — the start a person's notice is ABOUT, which must not
 * count itself.
 */
export function localSlotReading(inp: LocalSlotInput, exclude?: { sessionId?: string; rowId?: string }): { facts: LocalSlotFacts; pass: NonNullable<IntentFacts["local"]> } {
  const byId = new Map(inp.sessions.map((s) => [s.id, s]));
  const busy = new Set<string>();
  const working: LocalSlotFacts["working"] = [];
  for (const s of inp.sessions) {
    if (s.id === exclude?.sessionId || !s.running || !s.turnActive || !inp.isLocal(s.backend, s.model)) continue;
    busy.add(s.id);
    working.push({ id: s.id, ...(s.name ? { name: s.name } : {}) });
  }
  const rows = new Set<string>();
  for (const r of inp.rows) {
    if (r.id === exclude?.rowId || isTerminalRow(r)) continue;
    const on = rowRunsOn(r, byId);
    if (!on || !inp.isLocal(on.backend, on.model)) continue;
    if (r.state === "starting" || r.state === "running") {
      // In flight: counted once, whether or not its session is mid-turn yet.
      if (r.sessionId && (busy.has(r.sessionId) || r.sessionId === exclude?.sessionId)) continue;
      if (r.sessionId) busy.add(r.sessionId);
      const s = r.sessionId ? byId.get(r.sessionId) : undefined;
      working.push({ id: r.sessionId ?? r.id, ...(s?.name ? { name: s.name } : r.label ? { name: r.label } : {}) });
      continue;
    }
    // Only AUTOMATIC starts wait: an `auto` row, or one target of a sweep.
    if (r.auto || r.origin === ORIGIN_FANOUT_TARGET) rows.add(r.id);
  }
  const free = inp.max == null ? Number.MAX_SAFE_INTEGER : inp.max - working.length;
  return { facts: { max: inp.max, working }, pass: { free, rows, busy } };
}

function isTerminalRow(r: Intent): boolean {
  return r.state === "done" || r.state === "failed" || r.state === "canceled";
}

// ── The model, loaded ───────────────────────────────────────────────────────

/** How long a load may take before the row says so and tries again. A cold 30B model is ~60–80 s here. */
export const LOAD_TIMEOUT_MS = Number(env("LOCAL_LOAD_TIMEOUT_MS") || 180_000);
/** How long a failed load is believed before it is asked again (the tick retries). */
export const RETRY_MS = 30_000;
/** How long a finished load is trusted before the next fire asks the runner again. */
export const READY_FRESH_MS = 60_000;

export interface LoadDeps {
  load: (model: string, keepAlive: string, timeoutMs: number) => Promise<{ ok: true } | { ok: false; kind: LocalLoadFailure; error: string }>;
  now: () => number;
  /** A load settled — re-ask the ladder now, not on the next tick. */
  settled: () => void;
  url: () => string;
}

type LoadState =
  | { phase: "loading"; at: number }
  | { phase: "ready"; at: number }
  | { phase: "failed"; at: number; detail: string };

/** The sentence a failed load holds its row with. */
export function loadFailureText(model: string, kind: LocalLoadFailure, url: string, error: string, timeoutMs: number): string {
  switch (kind) {
    case "unreachable": return `waiting for the local model — Ollama is not reachable at ${url}; trying again shortly`;
    case "missing": return `waiting for the local model — ${model} is not on this desktop's Ollama (run \`ollama pull ${model}\`); trying again shortly`;
    case "timeout": return `waiting for the local model — ${model} did not finish loading within ${Math.round(timeoutMs / 1000)} s; trying again shortly`;
    default: return `waiting for the local model — Ollama could not load ${model} (${error}); trying again shortly`;
  }
}

/**
 * Is this model loaded? Synchronous, so the tick never awaits a runner: a
 * sentence HOLDS the row (`localModel`), `null` lets it fire. The first ask
 * starts a load in the background and holds; the load's end re-kicks the tick.
 * One load per model at a time, whichever rows ask.
 */
export class LocalModelGate {
  private readonly state = new Map<string, LoadState>();
  constructor(private readonly deps: LoadDeps) {}

  check(model: string): string | null {
    const now = this.deps.now();
    const st = this.state.get(model);
    if (st?.phase === "ready" && now - st.at < READY_FRESH_MS) return null;
    if (st?.phase === "loading" && now - st.at < LOAD_TIMEOUT_MS + 5_000) return loadingText(model);
    if (st?.phase === "failed" && now - st.at < RETRY_MS) return st.detail;
    this.state.set(model, { phase: "loading", at: now });
    const keepAlive = claudeLocalKeepAlive() ?? "30m";
    void this.deps.load(model, keepAlive, LOAD_TIMEOUT_MS).then((r) => {
      this.state.set(model, r.ok
        ? { phase: "ready", at: this.deps.now() }
        : { phase: "failed", at: this.deps.now(), detail: loadFailureText(model, r.kind, this.deps.url(), r.error, LOAD_TIMEOUT_MS) });
    }, (e) => {
      this.state.set(model, { phase: "failed", at: this.deps.now(), detail: loadFailureText(model, "error", this.deps.url(), String(e), LOAD_TIMEOUT_MS) });
    }).finally(() => { try { this.deps.settled(); } catch { /* a kick that throws is not the load's failure */ } });
    return loadingText(model);
  }
}

const loadingText = (model: string): string => `waiting for the local model — loading ${model} on Ollama`;

// ── The installed readers ───────────────────────────────────────────────────

interface Installed {
  sessions: () => readonly LocalSessionView[];
  rows: () => readonly Intent[];
  /** The synced setting's raw string. */
  setting: () => string | undefined;
  kick: () => void;
}

let installed: Installed | null = null;
let gate: LocalModelGate | null = null;

/** The desktop's own default when the phone never set one: `WATERPLANE_LOCAL_SESSIONS`, else 1. */
export function localSessionsDefault(): number | null {
  return localSessionsSetting(env("LOCAL_SESSIONS"), 1);
}

/** Wire the gate to the live host — once, at boot. */
export function installLocalSlots(i: Installed, deps?: Partial<LoadDeps>): void {
  installed = i;
  gate = new LocalModelGate({
    load: deps?.load ?? loadLocalModel,
    now: deps?.now ?? Date.now,
    settled: deps?.settled ?? (() => i.kick()),
    url: deps?.url ?? ollamaUrl,
  });
}

/** The cap in force right now (`null` = none). */
export function localSessionsMax(): number | null {
  return localSessionsSetting(installed?.setting(), localSessionsDefault());
}

function readingNow(exclude?: { sessionId?: string; rowId?: string }) {
  if (!installed) return null;
  return localSlotReading({ max: localSessionsMax(), sessions: installed.sessions(), rows: installed.rows(), isLocal: isLocalLaunch }, exclude);
}

/** `IntentFacts.local` for one pass, or absent when the gate is not installed. */
export function localSlotsPass(): IntentFacts["local"] {
  return readingNow()?.pass;
}

/** The `localModel` cap sentence in this host's numbers. */
export function localSlotsDetail(): string | undefined {
  const r = readingNow();
  return r ? localSlotWaitText(r.facts) : undefined;
}

/**
 * What a person's own start is told when it goes past the cap — `undefined`
 * when it does not, or when the start is not local at all.
 */
export function localStartNotice(launch: { backend?: string; model?: string } | undefined, exclude: { sessionId?: string; rowId?: string }): string | undefined {
  if (!isLocalLaunch(launch?.backend, launch?.model)) return undefined;
  const r = readingNow(exclude);
  return r ? localSlotOverText(r.facts) : undefined;
}

/**
 * The model gate for one row about to fire: a sentence holds it, `null` lets
 * it go. Only for a backend with a `localRunner` — the one runner this host
 * can load a model on.
 */
export function localModelHold(row: Intent): string | null {
  if (!installed || !gate) return null;
  const byId = new Map(installed.sessions().map((s) => [s.id, s]));
  const on = rowRunsOn(row, byId);
  if (!on?.model || runnerOf(on.backend) !== "ollama" || !isLocalLaunch(on.backend, on.model)) return null;
  return gate.check(on.model);
}

/**
 * May a sidecar call to `baseURL` run model `model` right now? A sentence
 * when it would swap the model out from under a working local coding turn —
 * same runner (host:port), a different model. `null` otherwise.
 */
export function localSwapGuard(baseURL: string, model: string): string | null {
  if (!installed) return null;
  let a: URL, b: URL;
  try { a = new URL(baseURL); b = new URL(ollamaUrl()); } catch { return null; }
  const norm = (u: URL) => `${LOOPBACK.has(u.hostname) ? "loopback" : u.hostname}:${u.port}`;
  if (norm(a) !== norm(b)) return null;
  const want = modelBaseName(model);
  const working = installed.sessions().filter((s) => s.running && s.turnActive && s.model && isLocalLaunch(s.backend, s.model));
  if (!working.length || working.some((s) => modelBaseName(s.model!) === want)) return null;
  const on = [...new Set(working.map((s) => modelBaseName(s.model!)))].join(", ");
  return `a local coding session is working on ${on} — the sidecar's ${want} would swap it out mid-turn, so this call was skipped`;
}
