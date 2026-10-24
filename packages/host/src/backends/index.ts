/**
 * Which backend a session runs on — and what happens when nobody knows.
 *
 * ── Absent means claude ─────────────────────────────────────────────────────
 *
 * Every session that exists today runs `claude` and says nothing about it, and
 * that stays true: no id, or `undefined`, resolves to the claude descriptor.
 * The wire is versioned by omission here rather than by a default written into
 * a DTO, so an old client that has never heard of backends keeps launching
 * exactly what it launched before.
 *
 * ── An unknown id is REFUSED, in words ──────────────────────────────────────
 *
 * The tempting shape is `TABLE[id] ?? claudeBackend` — one character, no error
 * path, and wrong in the one way that matters. The whole point of the id is to
 * choose which BINARY gets spawned with which flags; silently substituting
 * claude for a name this host does not know means a launch the person asked for
 * did not happen and something else happened instead, with nothing on screen
 * saying so. That is the failure mode this repo names explicitly: nothing
 * applies itself, and a reader that cannot answer degrades to absent, never to
 * a plausible wrong answer.
 *
 * So this throws, and the message names the id and lists what this host does
 * know — because the caller's job is to turn it into a refused op the person
 * can act on ("this host has no backend called X; it has: claude"), and a
 * message that only said "unknown backend" would leave them guessing at the
 * spelling. `durableOp()` in `server/wsops.ts` treats a THROWN failure as not
 * remembered, which is the right memory for this one: fix the id, send again.
 */
import type { BackendInfo } from "@waterplane/shared";
import { claudeBackend } from "./claude.js";
import { claudeLocalBackend } from "./claude-local.js";
import { claudeEndpointBackend } from "./claude-endpoint.js";
import { shellBackend } from "./shell.js";
import type { BackendDescriptor, BackendModels } from "./types.js";
import { BACKENDS, liveIds, registerCore } from "./registry.js";
import { derive } from "./derive.js";

export * from "./types.js";
export * from "./registry.js";
export { PROMPT_READERS, TRANSCRIPT_READERS, contributedReaders, registerScreenReader, registerStoreReader, screenReaderFor, storeReaderFor, namesStoreReader } from "./readers.js";
export type { PromptReaderName, TranscriptReaderName } from "./readers.js";
export { derive, walk, factProblems, CORE_SCREEN, CORE_STORE } from "./derive.js";
export type { Derived } from "./derive.js";
export { claudeBackend, claudeBin, hookSettingsArg, CLAUDE_FACTS, ACCOUNTLESS_CLAUDE_FACTS, CLAUDE_EFFORTS } from "./claude.js";
export { claudeLocalBackend, claudeLocalEnv, claudeLocalUrl, claudeLocalLeanArgs, claudeLocalKeepAlive, leanArgs, LEAN_TOOLS, windowFromShow } from "./claude-local.js";
export { claudeEndpointBackend, endpointConfig } from "./claude-endpoint.js";
export { shellBackend, shellBin, ensureBrowserShim, browserShimText, BROWSER_SHIM, SHELL_DROP_ENV } from "./shell.js";

// Core's, in the order a person is offered them. Plugin backends join the same
// list through `registerBackend` (`registry.ts`) and leave it again — opencode
// among them, from its in-repo extension (`packages/extensions/opencode/`).
registerCore(claudeBackend);
registerCore(claudeLocalBackend);
registerCore(claudeEndpointBackend);
// A plain login shell (`shell.ts`): no turns, no model — `BackendInfo.kind: "shell"`.
registerCore(shellBackend);

/** The one a session gets when it says nothing about backends. */
export const DEFAULT_BACKEND = claudeBackend;

/** Is this a backend id this host knows? Answers without throwing. */
export function knownBackend(id: string): boolean {
  return BACKENDS.some((b) => b.id === id);
}

/**
 * Resolve a backend id to its descriptor.
 *
 * Absent ⇒ claude. Unknown ⇒ **throws**, with a sentence naming the id and the
 * ids that would have worked. See the file header for why this is not a
 * fallback.
 */
export function resolveBackend(id?: string): BackendDescriptor {
  if (!id) return DEFAULT_BACKEND;
  const found = BACKENDS.find((b) => b.id === id);
  if (found) return found;
  throw new Error(
    `This host has no backend called "${id}". It can run: ${liveIds()}.`,
  );
}

/**
 * The model catalogues, asked ONCE at boot.
 *
 * A catalogue is a subprocess (`opencode models`), and the frame that carries it
 * goes out on every socket that connects — so it is read once and remembered,
 * never per hello. Unprimed and failed look the same on purpose: an EMPTY
 * catalogue, which the phone renders as a free-text field. That is the honest
 * answer in both cases, and it is the one shape that cannot offer a model this
 * install does not have.
 */
const MODEL_CACHE = new Map<string, BackendModels>();

/**
 * The running CLI version of each backend that declares `measured` (plugins), asked beside the
 * catalogue and remembered the same way: `null` = the binary could not tell. Absent = never asked
 * or no `measured` at all.
 */
const RUNNING_VERSION = new Map<string, string | null>();

/**
 * "measured on X, running Y" as the sentence a person reads (review R6; plan §3.6): present only
 * when the plugin named the versions it was measured on AND the running binary answered with one
 * that is none of them. Never a refusal — the backend still launches; the sentence says what may
 * be misread. Pure.
 */
export function measuredDriftText(label: string, versions: readonly string[], running: string | null | undefined): string | null {
  if (!running || !versions.length || versions.includes(running)) return null;
  const on = versions.length === 1 ? versions[0] : `${versions.slice(0, -1).join(", ")} or ${versions[versions.length - 1]}`;
  return `${label} was measured on ${on}, and this desktop is running ${running} — its screens or records may read differently until the plugin is measured on ${running}. It still starts.`;
}

/** Ask one backend for its running version, when it declares `measured`. Never throws. */
async function askRunning(b: BackendDescriptor): Promise<void> {
  if (!b.measured) { RUNNING_VERSION.delete(b.id); return; }
  let v: string | null = null;
  try { v = await b.measured.version(); } catch { v = null; }
  if (!BACKENDS.includes(b)) return; // removed while it was being asked
  RUNNING_VERSION.set(b.id, v);
  const drift = measuredDriftText(b.label, b.measured.versions, v);
  if (drift) console.log(`[backend] ${b.id}: ${drift}`);
}

/** Ask every backend for its catalogue (and a plugin for its running version). Never throws; never rejects. */
export async function primeBackendModels(): Promise<void> {
  await Promise.all(BACKENDS.map(async (b) => {
    try { MODEL_CACHE.set(b.id, await b.models()); }
    catch { MODEL_CACHE.set(b.id, { aliases: [], ids: [] }); }
    await askRunning(b);
  }));
}

/**
 * After the list changed (a plugin registered or removed a backend): forget
 * the catalogues of backends that left, ask only the ones never asked. A
 * backend that registers after boot would otherwise stay an empty catalogue
 * for ever. Never throws; never rejects. True when anything was asked.
 */
export async function primeNewBackendModels(): Promise<boolean> {
  const live = new Set(BACKENDS.map((b) => b.id));
  for (const id of [...MODEL_CACHE.keys()]) if (!live.has(id)) MODEL_CACHE.delete(id);
  for (const id of [...RUNNING_VERSION.keys()]) if (!live.has(id)) RUNNING_VERSION.delete(id);
  const fresh = BACKENDS.filter((b) => !MODEL_CACHE.has(b.id));
  // Marked first, so two changes in a row do not ask one backend twice.
  for (const b of fresh) MODEL_CACHE.set(b.id, { aliases: [], ids: [] });
  await Promise.all(fresh.map(async (b) => {
    let m: BackendModels;
    try { m = await b.models(); } catch { m = { aliases: [], ids: [] }; }
    // Removed (or replaced) while it was being asked: the answer is about nobody.
    if (BACKENDS.includes(b)) MODEL_CACHE.set(b.id, m);
    await askRunning(b);
  }));
  return fresh.length > 0;
}

/** When each backend's catalogue was last RE-asked because it said unavailable. */
const RECHECKED_AT = new Map<string, number>();

/**
 * A catalogue that said "unavailable" (Ollama not reachable) was true at boot and
 * stays that way for ever unless somebody asks again — and the phone removes the
 * Start button on it. So: re-ask exactly the backends currently UNAVAILABLE, at
 * most once per `minGapMs` each (a hello from every reconnecting socket must not
 * become a probe per hello). Healthy catalogues are never re-asked here.
 * Never throws. True when an answer changed what the phone is told.
 */
export async function recheckUnavailableBackends(minGapMs: number, now = Date.now()): Promise<boolean> {
  const due = BACKENDS.filter((b) => MODEL_CACHE.get(b.id)?.unavailable && now - (RECHECKED_AT.get(b.id) ?? 0) >= minGapMs);
  for (const b of due) RECHECKED_AT.set(b.id, now);
  let changed = false;
  await Promise.all(due.map(async (b) => {
    let m: BackendModels;
    try { m = await b.models(); } catch { return; }
    if (!BACKENDS.includes(b)) return;
    const before = MODEL_CACHE.get(b.id);
    if (before?.unavailable !== m.unavailable || before?.ids.length !== m.ids.length) changed = true;
    MODEL_CACHE.set(b.id, m);
  }));
  return changed;
}

/**
 * How many tokens of context one model is CONFIGURED to hold, per the backend
 * that offers it. Null when nobody said.
 *
 * Read out of the same cache the catalogue lives in, because it came out of the
 * same probe (`backends/opencode.ts`'s `providerHosting`) and a second store
 * would be a second thing to prime and a second thing to be stale. A backend
 * that never answered, a model missing from the map, an unprimed cache: all of
 * them are null, and null is what makes `ContextSeriesDoc.windowTok` absent and
 * `windowFrom: "none"` — the graph then plots tokens on their own axis and says
 * so, which is the shape it already had.
 *
 * **Never a fallback to another model's window, and never to claude's.** The
 * caller asks about the model that actually ran.
 */
export function backendContextWindow(backendId: string | undefined, model: string | undefined): number | null {
  if (!model) return null;
  const id = backendId || DEFAULT_BACKEND.id;
  const w = MODEL_CACHE.get(id)?.contextWindow?.[model];
  return typeof w === "number" && w > 0 ? w : null;
}

/**
 * Where one model of one backend RUNS, per the catalogue the backend gave
 * (`models.where`) — `null` when nobody said. Never inferred from the id's
 * spelling. The local-model gate's locality fact for a backend that has no
 * `localRunner` of its own (opencode's local providers).
 */
export function backendModelWhere(backendId: string | undefined, model: string | undefined): "local" | "hosted" | null {
  if (!model) return null;
  const w = MODEL_CACHE.get(backendId || DEFAULT_BACKEND.id)?.where?.[model];
  return w === "local" || w === "hosted" ? w : null;
}

/**
 * May a "fork this conversation at turn N" be attempted against this backend?
 * A sentence when it may not, null when it may.
 *
 * **The refusal is in WORDS, before anything happens.** `convfork.ts` forks a
 * conversation by copying claude's jsonl up to a turn and writing a new one; run
 * against an opencode session it is handed a `ses_…` id and a cwd, builds a path
 * under `~/.claude/projects` that cannot exist, and fails with a file-not-found
 * — a sentence about a path nobody asked about, for a verb the person did ask
 * for. And there is no version of it that could succeed: the record is rows in a
 * live database this app must never write to.
 *
 * So it is refused where the request arrives, the op comes back `ok:false`
 * carrying this sentence onto the queue row, and NOTHING is spawned and nothing
 * is written. `caps.fork` already keeps the button off the phone; this is the
 * guard for every other caller, which is the same division of labour
 * `launchArgs`'s `"pick"` refusal has.
 */
export function forkAtTurnRefusal(backendId?: string): string | null {
  let backend: BackendDescriptor;
  // An unknown id is not this function's to refuse — `create()` throws on it a
  // moment later with a sentence naming the known ids, and answering here would
  // replace that sentence with a less useful one.
  try { backend = resolveBackend(backendId); } catch { return null; }
  if (backend.forkVia === "server") return null; // the backend forks it itself; `convfork.ts` never sees it
  // claude's jsonl is cut by `convfork.ts` — and ONLY claude's: every other backend is refused
  // here, before `routes/session.ts` reaches `forkConversationFile` with an id that is not a
  // claude conversation — unless its own source cuts it (`conversations.fork`, `forkViaSource`).
  const d = derive(backend);
  if (d.keepsClaudeLog || d.sourceForks) return null;
  if (d.store("transcript") !== null) return `${backend.label} keeps its conversation in a live database this host only ever reads, so a conversation cannot be cut at a turn and re-opened as a new one. Resume this conversation instead, or start a fresh session.`;
  return `${backend.label} keeps no conversation file this host can copy, so a conversation cannot be cut at a turn and re-opened as a new one. Resume this conversation instead, or start a fresh session.`;
}

/**
 * **A job never opens a shell** (R-shell-004). A backend with no turns
 * (`caps.turns === false`, the shell) is opened only by a person's tap — the
 * `session.create` op stamps `origin.kind: "hand"`. Every other opener (the
 * intent tick, a parked create, the fan-out, the backlog, an agent's post) is
 * refused HERE, in `SessionManager.create`, the one point all of them pass,
 * before a spawn — so no new opener can forget it. A fork of a shell is
 * `launchArgs`'s own refusal ("no conversation to continue").
 */
export function shellOpenRefusal(backend: Pick<BackendDescriptor, "caps">, origin?: { kind: string }): string | null {
  if (backend.caps.turns !== false) return null;
  if (origin?.kind === "hand" || origin?.kind === "fork") return null;
  return "a job never opens a shell — open one from the repo's menu";
}

/** Does this backend fork a conversation on its own server (`forkVia: "server"`)?
 *  An unknown id answers false — `create()` refuses it in words a moment later. */
export function backendForksOnServer(backendId?: string): boolean {
  try { return resolveBackend(backendId).forkVia === "server"; } catch { return false; }
}

/** The descriptor when its own source cuts a conversation at a turn (`derive`'s `sourceForks`), else null. */
export function backendForkingSource(backendId?: string): BackendDescriptor | null {
  try { const b = resolveBackend(backendId); return derive(b).sourceForks ? b : null; } catch { return null; }
}

/**
 * The wire document for every backend this host can spawn — DERIVED from the
 * descriptors, never hand-written.
 *
 * A second table of capabilities would be a second opinion about what a backend
 * can do, and the one that was wrong would be the one the phone believes. The
 * translation is `derive.ts`'s `wireCaps`: the host's provider lists (which reader, which
 * channel) become the simpler question a client can act on (is there one at all).
 */
function measuredInfo(label: string, versions: readonly string[], running: string | null | undefined): NonNullable<BackendInfo["measured"]> {
  const drift = measuredDriftText(label, versions, running);
  return { versions: [...versions], ...(running ? { running } : {}), ...(drift ? { drift } : {}) };
}

export function backendInfos(): BackendInfo[] {
  return BACKENDS.map((b): BackendInfo => {
    const m = MODEL_CACHE.get(b.id) ?? { aliases: [], ids: [] };
    return {
      id: b.id,
      label: b.label,
      // A backend with no turns is a SHELL to the phone — offered as "open a
      // shell here", never in the model picker. Absent for every agent.
      ...(b.caps.turns === false ? { kind: "shell" as const } : {}),
      // Every boolean is DERIVED from the provider table (`derive.ts`), so a cap and a source
      // can never disagree; the bytes are pinned (`backendinfos.pin.test.mjs`).
      caps: derive(b).wireCaps(),
      // `where` rides along only when the backend could actually determine it.
      // Spread rather than `where: m.where` so an absent map stays ABSENT on
      // the wire instead of becoming an explicit `undefined` key — the phone
      // reads "no map" as "this host cannot say", which is a different claim
      // from "no model is local".
      models: { aliases: [...m.aliases], ids: [...m.ids], ...(m.where ? { where: { ...m.where } } : {}), ...(m.zeroCost?.length ? { zeroCost: [...m.zeroCost] } : {}),
        // Per-model window and MEASURED first-request overhead: the picker's
        // window sentence (`windowAdviceText`). Absent stays absent.
        ...(m.contextWindow && Object.keys(m.contextWindow).length ? { contextWindow: { ...m.contextWindow } } : {}),
        ...(m.overheadTok && Object.keys(m.overheadTok).length ? { overheadTok: { ...m.overheadTok } } : {}),
        ...(m.note ? { note: m.note } : {}) },
      ...(m.unavailable ? { unavailable: m.unavailable } : {}),
      ...(b.experimental ? { experimental: true as const } : {}),
      // The versions a plugin was measured on, the running one, and the drift sentence (R6).
      // Absent for a backend that declares no `measured` — every core backend (the pin holds).
      ...(b.measured ? { measured: measuredInfo(b.label, b.measured.versions, RUNNING_VERSION.get(b.id)) } : {}),
      // `contextWindowTokens` is deliberately never set: no backend here has a
      // window size that is a fixed fact about the BACKEND rather than about a
      // model on somebody's disk, and absent is what that must read as.
    };
  });
}
