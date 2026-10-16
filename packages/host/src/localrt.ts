/**
 * What the LOCAL model runner is actually doing right now.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * A hosted model's cost is a number on somebody's invoice. A LOCAL model's cost
 * is this machine — 18 GB resident for `qwen3-coder:30b`, on a desktop that
 * measured 59.3 GB of RSS and a nearly-full swap file before anybody asked it to
 * think. That cost is completely invisible today: the phone shows a session
 * working and nothing about the 18 GB it just paged in.
 *
 * The connection strip (`link.ts` / `NetPulseBar`) is the shape this follows —
 * one thin always-available readout of a fact you otherwise only discover when
 * it has already gone wrong.
 *
 * ── What is measured, and what is deliberately absent ───────────────────────
 *
 * Measured, from ollama's own `/api/ps`: which models are RESIDENT, how many
 * bytes each is holding, and when the runner intends to evict them. Measured
 * from the OS: CPU load, memory, and — Apple Silicon only, via `host.ts`'s
 * `readGpuStat` — GPU utilization and GPU memory in use. All are facts, cheap
 * to read, and local — this does not talk to the internet and costs no tokens.
 *
 * The rest of the machine rides along on `sample.sys` (`sysstat.ts`): the CPU
 * split, where the memory actually went, which programs are holding it, and the
 * temperature where this host has any way to read one. It is sampled HERE, in
 * this poll, rather than on a stream of its own — it answers the questions this
 * sample provokes ("1.1 GB free of 64 GB, held by WHAT?"), and a second lease
 * with a second cadence would be a readout that can disagree with the one beside
 * it. Its two expensive readers keep a slower cadence of their own and never
 * throw.
 *
 * **Tokens per second is ABSENT, and that is a decision.** Neither `/api/ps`
 * nor opencode publishes a live throughput figure this host can read. It could
 * be estimated — bytes off the PTY over wall-clock — and the estimate would be
 * wrong in the two directions that matter: the TUI repaints, so screen bytes are
 * not output tokens, and a model thinking silently produces no bytes at all
 * while doing the expensive part. A throughput number nobody can act on is worse
 * than a blank space, and this repo's standing rule is that a reading degrades
 * to absent rather than to a plausible wrong number. When there is a real
 * measurement path it goes here; until then the field does not exist.
 *
 * ── Cost of the poll itself ─────────────────────────────────────────────────
 *
 * One loopback GET with a short timeout, and only while a client is watching.
 * The runner not being there is the normal case for most installs and must be
 * silent: no retry storm, no log line per failure, no "degraded" state on a
 * screen belonging to somebody who does not use local models at all.
 */
import { hostStat, readGpuStat } from "./host.js";
import { sampleSysStat } from "./sysstat.js";
import { modelBaseName } from "@waterplane/shared";
import type { LocalRuntimeSample, LoadedModel } from "@waterplane/shared";
import { env } from "./env.js";

/**
 * The shapes and the pressure sentence moved to `@waterplane/shared` the moment the
 * PHONE had to draw them — a fact the host measures and the phone renders is a
 * fact both ends must word identically. Re-exported here so every existing
 * import of this module, and `packages/host/test/localrt.test.mjs`, keep
 * working unchanged.
 */
export type { LocalRuntimeSample, LoadedModel };
export { memoryPressureNote } from "@waterplane/shared";

/** Where the local runner lives. One place it is read, per this repo's rule for
 *  every other binary/env pair. */
export const ollamaUrl = (): string =>
  (env("OLLAMA_URL") || "http://127.0.0.1:11434").replace(/\/+$/, "");

/** Off entirely — for a desktop that runs no local models and wants no poll. */
export const localRuntimeEnabled = (): boolean => env("LOCAL_RUNTIME") !== "0";

/**
 * "Which model is every live session running?" — installed once at boot
 * (`main.ts`), `clihealth.ts`'s singleton arrangement for its reason: this
 * module has no `HostCtx` and threading a `SessionManager` through every
 * `sampleLocalRuntime` call site to answer one join would give it a dependency
 * it otherwise has none of.
 *
 * **Unset is a silent no-op** — `sessionsUsing` stays ABSENT on every model
 * rather than reporting a guessed `0`. A real `0` means "asked, and nobody is
 * running it"; an unset provider means the question was never asked at all,
 * and those are different facts (`wire/localrt.ts`'s rule for this field).
 */
let sessionModels: (() => readonly (string | undefined)[]) | null = null;
export function installSessionModels(fn: () => readonly (string | undefined)[]): void {
  sessionModels = fn;
}

/**
 * Join resident models against live sessions, by the runner's own name for
 * each (`modelBaseName` strips a backend's provider prefix — the same match
 * `memoryPressureNote` makes, because a session's `SessionInfo.model` and the
 * runner's `/api/ps` name the same bytes two different ways).
 */
function withSessionUsage(models: LoadedModel[]): LoadedModel[] {
  if (!sessionModels) return models;
  const live = sessionModels();
  return models.map((m) => ({
    ...m,
    sessionsUsing: live.filter((id) => id && modelBaseName(id) === m.name).length,
  }));
}

/**
 * Parse `/api/ps`.
 *
 * Exported so the shape is pinned without a runner installed — the same reason
 * `parseModelList` is exported from the opencode descriptor.
 *
 * **Every field degrades independently.** A row with no name is dropped (it
 * cannot be shown or matched to a session); a row with an unparsable size
 * contributes 0 bytes rather than `NaN`, which would poison every total drawn
 * from it; an unparsable `expires_at` is ABSENT rather than a guessed instant.
 */
export function parsePs(body: unknown): LoadedModel[] {
  const rows = (body as { models?: unknown })?.models;
  if (!Array.isArray(rows)) return [];
  const out: LoadedModel[] = [];
  for (const r of rows) {
    const m = r as { name?: unknown; model?: unknown; size?: unknown; size_vram?: unknown; expires_at?: unknown };
    const name = typeof m?.name === "string" && m.name ? m.name
      : typeof m?.model === "string" && m.model ? m.model : null;
    if (!name) continue;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
    const exp = typeof m.expires_at === "string" ? Date.parse(m.expires_at) : NaN;
    out.push({
      name,
      size: num(m.size),
      vram: num(m.size_vram),
      ...(Number.isFinite(exp) ? { expiresAt: exp } : {}),
    });
  }
  return out;
}

/**
 * Take one sample.
 *
 * A runner that is not there answers `reachable: false` and NOT an empty model
 * list — "nothing is loaded" and "nobody asked" are opposite facts, and the bar
 * words them differently.
 */
export async function sampleLocalRuntime(timeoutMs = 1500): Promise<LocalRuntimeSample> {
  const st = hostStat();
  const base: Omit<LocalRuntimeSample, "models" | "reachable" | "gpuPct" | "gpuMemInUse" | "sys"> = {
    at: Date.now(), cpuPct: st.cpuPct, memTotal: st.memTotal, memFree: st.memFree,
  };
  // Runtime disabled ⇒ no ollama fetch, no `ioreg` spawn AND no system readers —
  // `WATERPLANE_LOCAL_RUNTIME=0` is "poll nothing here", not "poll everything except
  // ollama", and `sysstat.ts` spawns `ps` and `vm_stat` of its own.
  if (!localRuntimeEnabled()) return { ...base, models: [], reachable: false };
  // In parallel: the GPU read, the system readers and ollama's own reachability
  // have nothing to do with one another, and paying ~13 ms of `ioreg` plus a
  // `vm_stat` serially around the fetch is latency this poll has no reason to
  // spend. `sampleSysStat` never throws and keeps its expensive halves on a
  // slower cadence of their own.
  const [gpu, sys, ps] = await Promise.all([
    readGpuStat(),
    sampleSysStat(),
    (async (): Promise<Pick<LocalRuntimeSample, "models" | "reachable">> => {
      try {
        const res = await fetch(`${ollamaUrl()}/api/ps`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return { models: [], reachable: false };
        return { models: withSessionUsage(parsePs(await res.json())), reachable: true };
      } catch {
        // Silent. A desktop with no local runner is the normal case and must not
        // produce a log line every few seconds, nor a "degraded" chip on a screen
        // belonging to somebody who never asked for local models.
        return { models: [], reachable: false };
      }
    })(),
  ]);
  return { ...base, ...(gpu ? { gpuPct: gpu.pct, gpuMemInUse: gpu.memInUse } : {}), sys, ...ps };
}

/**
 * Unload one resident model right now, instead of waiting for its own
 * `keep_alive` to expire.
 *
 * Ollama's own way to force this is a generate call with no prompt and
 * `keep_alive: 0` — there is no dedicated "unload" endpoint. `error` is the
 * runner's own sentence (an HTTP status, or the fetch failure's message),
 * never a translated code: there is no richer vocabulary for "why" than what
 * the runner or the network already said, and inventing one would be a
 * plausible wrong reason standing in for an honest unknown one.
 */
export async function evictLocalModel(name: string, timeoutMs = 5000): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${ollamaUrl()}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: name, keep_alive: 0 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, error: `the runner answered ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Load one model now and ask the runner to hold it for `keepAlive` — the
 * mirror of `evictLocalModel`: a generate call with no prompt loads the model
 * and returns, and its `keep_alive` sets how long it stays resident.
 *
 * Used when a `claude-local` session starts (`backends/claude-local.ts`), so the
 * cold load (measured: most of a 67-81 s first turn) overlaps the person typing
 * instead of following it. Fire-and-forget at the call site: the launch never
 * waits on it, and a failure is only the runner's own sentence.
 * `keepAlive` is passed through as Ollama spells it ("30m", "-1", seconds).
 */
export async function warmLocalModel(name: string, keepAlive: string, timeoutMs = 300_000): Promise<{ ok: boolean; error?: string }> {
  const ka: string | number = /^-?\d+$/.test(keepAlive) ? Number(keepAlive) : keepAlive;
  try {
    const res = await fetch(`${ollamaUrl()}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: name, keep_alive: ka }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, error: `the runner answered ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Why a load did not finish — `loadLocalModel`'s failure vocabulary. */
export type LocalLoadFailure = "unreachable" | "missing" | "timeout" | "error";

/**
 * Load one model and WAIT for it — `warmLocalModel` with the failure told
 * apart, for the local-model gate (`localslot.ts`) that holds an automatic
 * item until the model it opens on is resident. A 404 is Ollama saying it has
 * no such model (never "unreachable"); an abort past `timeoutMs` is `timeout`;
 * a refused connection is `unreachable`. `error` is the runner's own sentence.
 */
export async function loadLocalModel(name: string, keepAlive: string, timeoutMs: number): Promise<{ ok: true } | { ok: false; kind: LocalLoadFailure; error: string }> {
  const ka: string | number = /^-?\d+$/.test(keepAlive) ? Number(keepAlive) : keepAlive;
  try {
    const res = await fetch(`${ollamaUrl()}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: name, keep_alive: ka }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return { ok: false, kind: "missing", error: "the runner has no such model" };
    if (!res.ok) return { ok: false, kind: "error", error: `the runner answered ${res.status}` };
    // Drain the body: the answer is a one-line `done_reason: "load"` document.
    await res.text().catch(() => "");
    return { ok: true };
  } catch (e) {
    const err = e as { name?: string; message?: string };
    if (err?.name === "TimeoutError" || err?.name === "AbortError") return { ok: false, kind: "timeout", error: "it did not finish loading in time" };
    return { ok: false, kind: "unreachable", error: err?.message || String(e) };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// The watch manager — a LEASE, not a subscription
// ────────────────────────────────────────────────────────────────────────────

/**
 * How long one `localrt.watch` buys.
 *
 * **Why a lease and not a subscription.** The route table has no socket-close
 * hook: a handler is handed its `ws` and nothing tells this module when that
 * socket dies. A set the host prunes on close is therefore a leak the first day
 * a close event is missed — a phone that went through a tunnel drop keeps a
 * desktop polling its runner for ever, and nothing on either end can see it.
 * A lease cannot do that: it expires by itself. A client that stops renewing
 * lapses within a minute, costing at most one lease period of loopback GETs,
 * which is the cheap direction to be wrong in.
 *
 * Sixty seconds against the client's 25 s renewal is deliberately two renewals
 * of slack: a phone that misses one pump tick (a backgrounded WebView, a
 * reconnect) must not lose the readout it is looking at.
 */
export const LEASE_MS = 60_000;

/**
 * How often a watched sample is taken.
 *
 * The events this catches are a model being loaded or evicted (ollama's
 * `keep_alive` default is five minutes) and memory pressure. Neither moves at
 * sub-second speed, so a faster poll buys nothing and spends a frame on the
 * link this app spends its life apologising for. Floored, because a hand-edited
 * `WATERPLANE_LOCALRT_POLL_MS=1` would turn a readout into a load generator.
 */
const POLL_FLOOR_MS = 1_000;
export function localRtPollMs(): number {
  const n = Number(env("LOCALRT_POLL_MS"));
  return Number.isFinite(n) && n > 0 ? Math.max(POLL_FLOOR_MS, n) : 5_000;
}

/** A socket, as much of one as this module has any business knowing about.
 *  Structural so the manager can be driven with no `ws` and no daemon. */
export interface WatchSocket {
  /** `1` is OPEN in every WebSocket implementation and in the standard. */
  readonly readyState: number;
}
const WS_OPEN = 1;

/** What a lease is, reduced to the two facts that decide its fate. */
export interface WatchLease {
  /** ms epoch the lease runs out at. */
  until: number;
  /** Is the socket that took it still open? */
  open: boolean;
}

/** The split `pollTick` acts on: who gets this sample, and who is dropped. */
export interface WatchSplit<K> {
  live: K[];
  lapsed: K[];
}

/**
 * **The lease bookkeeping, pure.**
 *
 * Extracted so the rules below can be pinned with no daemon, no socket and no
 * clock, because all three of them fail silently:
 *
 *  - a renewal that does not actually extend the lease drops the readout every
 *    minute, which on a phone looks like a flaky desktop;
 *  - a lapsed or closed entry that is not dropped is the leak the lease exists
 *    to prevent;
 *  - **an empty result is the STOP condition.** The timer must go away with its
 *    last watcher — a daemon that keeps polling a local HTTP endpoint for ever
 *    because somebody once opened a strip is exactly the cost this readout is
 *    supposed to be measuring, not paying.
 *
 * A closed socket lapses even with time left on its lease: the clock is the
 * backstop for a close nobody saw, not a reason to keep writing into a dead one.
 */
export function dueWatchers<K>(entries: Iterable<readonly [K, WatchLease]>, now: number): WatchSplit<K> {
  const live: K[] = [];
  const lapsed: K[] = [];
  for (const [key, lease] of entries) {
    if (lease.open && lease.until >= now) live.push(key);
    else lapsed.push(key);
  }
  return { live, lapsed };
}

/** What the manager is allowed to say. Structural for `WatchSocket`'s reason —
 *  the route hands over a closure, not a transport. */
type WatchSend = (msg: { t: "localrt.sample"; sample: LocalRuntimeSample; disabled?: true }) => void;

const watchers = new Map<WatchSocket, { until: number; send: WatchSend }>();
let timer: NodeJS.Timeout | null = null;

/** How many leases are outstanding. Exported for the test, and for nothing
 *  else: no route reads it, and no decision is taken on it. */
export function localRtWatchCount(): number { return watchers.size; }

/**
 * A client asked to watch the local runner.
 *
 * **Answers immediately, always.** That is not a latency nicety: a host that
 * predates this feature ignores an unknown `t` silently (the wire is
 * versioned, and that is the correct behaviour), so from the phone's side
 * "this desktop is old" and "this desktop is answering and the runner is quiet"
 * are the same silence. One frame back on the spot is what separates them, and
 * the phone says the two things differently — see `web/localRt.ts`.
 *
 * With polling switched off (`WATERPLANE_LOCAL_RUNTIME=0`) this takes NO lease and
 * starts NO timer: it sends one `disabled: true` frame and stops. "Polling is
 * off on this desktop" is a standing fact about the machine, not a reading that
 * needs refreshing, and a lease would buy a poll loop that can only ever report
 * the same nothing.
 */
export function localRtWatch(ws: WatchSocket, send: WatchSend): void {
  if (!localRuntimeEnabled()) {
    const st = hostStat();
    // GPU is deliberately absent here, unlike CPU/memory: this branch's whole
    // contract is answering SYNCHRONOUSLY, in the same tick, so a host that
    // predates this feature (silent on an unknown `t`) can be told apart from
    // one that is answering with polling off (pinned by
    // `localrt.test.mjs`'s "answers ONCE"). `readGpuStat` spawns a subprocess
    // and cannot resolve inside that tick — see `sampleLocalRuntime`, which
    // DOES read it, for the path a live watch takes instead.
    send({
      t: "localrt.sample",
      // `reachable: false` here means NOBODY ASKED, and `disabled` is what says
      // so. The two must never be read apart — see `wire/localrt.ts`.
      sample: { at: Date.now(), models: [], reachable: false, cpuPct: st.cpuPct, memTotal: st.memTotal, memFree: st.memFree },
      disabled: true,
    });
    return;
  }
  watchers.set(ws, { until: Date.now() + LEASE_MS, send });
  // The lease's own first sample, before the timer's first tick — a strip that
  // showed nothing for five seconds after being switched on is a strip people
  // conclude is broken.
  void sampleLocalRuntime().then((sample) => {
    if (ws.readyState === WS_OPEN) send({ t: "localrt.sample", sample });
  });
  start();
}

function start(): void {
  if (timer) return;
  timer = setInterval(pollTick, localRtPollMs());
  // Never a reason to keep the process alive: this is a readout, and a daemon
  // that will not exit because a phone once opened a strip is a bug.
  if (typeof timer.unref === "function") timer.unref();
}

function stop(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/**
 * One poll: ONE sample, fanned out to every live watcher.
 *
 * One sample for all of them on purpose — five phones watching must not cost
 * five HTTP round trips to the runner, and they are all asking the same
 * question about the same machine. The split is re-taken AFTER the await
 * because a socket can die inside it, and writing a frame into a dead one is
 * the leak this whole arrangement exists to avoid.
 */
function pollTick(): void {
  const { live, lapsed } = splitNow(Date.now());
  for (const k of lapsed) watchers.delete(k);
  if (!live.length) { stop(); return; }
  void sampleLocalRuntime().then((sample) => {
    const after = splitNow(Date.now());
    for (const k of after.lapsed) watchers.delete(k);
    for (const k of after.live) watchers.get(k)?.send({ t: "localrt.sample", sample });
    if (!after.live.length) stop();
  });
}

function splitNow(now: number): WatchSplit<WatchSocket> {
  const rows: (readonly [WatchSocket, WatchLease])[] = [];
  for (const [ws, w] of watchers) rows.push([ws, { until: w.until, open: ws.readyState === WS_OPEN }] as const);
  return dueWatchers(rows, now);
}
