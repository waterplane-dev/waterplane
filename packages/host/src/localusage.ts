/**
 * The LOCAL runner's ledger: compute time, tokens and memory per model per day,
 * read passively — `GET /api/localusage`.
 *
 * ── Sources (measured: docs/analysis/spikes/2026-10-02-local-usage-metrics.md) ──
 *
 *  - **Compute and tokens: ollama's own `server.log`, tailed.** Ollama runs each
 *    model through a `llama-server` child and copies its `print_timing` block
 *    into the log at the DEFAULT level: prompt tokens processed + their time,
 *    tokens generated + their time — byte-for-byte what `/api/chat` returns in
 *    its own duration fields. The `[GIN]` access line after it carries the HTTP
 *    path and the request's WALL time ("time to answer", which includes waiting
 *    in the runner's queue — 3.4 s of 3.65 s in the spike). None of the three
 *    backends' APIs (`/v1/messages`, `/v1/responses`, `/v1/chat/completions`)
 *    carry the durations, and reading their responses would mean sitting in
 *    their path; the log does not.
 *  - **Which model: `/api/ps`, sampled.** The timing lines name no model and
 *    an unload is not logged, so a request is tied to a model only by what ps
 *    said was resident around it (`pickModel`) — and is otherwise counted as
 *    `model: null`, never guessed onto the last-loaded one.
 *  - **Memory: the same ps samples** (resident bytes, the GPU's share, context),
 *    plus `sysstat.ts`'s memory reader while a model is resident.
 *
 * ── Posture ─────────────────────────────────────────────────────────────────
 *
 * Never in a request path, never blocking: one loopback GET and one bounded
 * async read of the log's NEW bytes per tick (20 s; ×4 while ollama does not
 * answer), the machine reader only while something is resident. A ROTATED log
 * is caught up on the same way — one `CHUNK` per tick off its own persisted
 * cursor (`drain`), never the whole file at once — and every chunk's regexes
 * hand the loop back every 8 ms (`parseRunnerLogYielding`). Every failure
 * is an absent field or a sentence in the document. The ledger starts when this
 * host first watched (no back-fill: attribution needs ps samples from the time).
 * Bounded: `KEEP_DAYS` days, `UNRESOLVED_CAP` events awaiting a sample, written
 * tmp+rename at most every `SAVE_MS`, the cursors in the same file so a restart
 * neither loses nor re-counts a request.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { open, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import {
  addModelDay, envName, localDayKey, UNATTRIBUTED_WHY,
  type LocalModelDay, type LocalUsageDay, type LocalUsageDoc, type LocalUsageLog, type MemBreakdown,
} from "@waterplane/shared";
import { env } from "./env.js";
import { hostStateDir } from "./branddirs.js";
import { localRuntimeEnabled, ollamaUrl, parsePs } from "./localrt.js";
import { sampleMemory } from "./sysstat.js";

// ── Knobs ───────────────────────────────────────────────────────────────────

/** `WATERPLANE_LOCAL_USAGE=0` switches the ledger off; `WATERPLANE_LOCAL_RUNTIME=0`
 *  ("poll nothing local here") does too. */
export const localUsageEnabled = (): boolean => env("LOCAL_USAGE") !== "0" && localRuntimeEnabled();

/** `WATERPLANE_LOCAL_USAGE_MS`, default 20 s, floored at 5 s. */
export function localUsageIntervalMs(): number {
  const n = Number(env("LOCAL_USAGE_MS"));
  return Number.isFinite(n) && n > 0 ? Math.max(5000, Math.round(n)) : 20_000;
}

/** Where ollama writes its server log, or why there is no path. */
export function ollamaLogPath(platform = process.platform, home = homedir()): { file: string } | { reason: string } {
  const o = (env("OLLAMA_LOG") || "").trim();
  if (o === "0") return { reason: `reading it is switched off here (${envName("OLLAMA_LOG")}=0).` };
  if (o) return { file: o };
  if (platform === "darwin") return { file: join(home, ".ollama", "logs", "server.log") };
  if (platform === "win32") return { file: join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "Ollama", "server.log") };
  return { reason: `on Linux ollama logs to the systemd journal, not a file; set ${envName("OLLAMA_LOG")} to a file it writes.` };
}

const KEEP_DAYS = 120;
const SAVE_MS = 30_000;
/** Bytes read per tick; the rest waits for the next one. */
const CHUNK = 4 * 1024 * 1024;
/** Past this many bytes with no commit point, give up on what was pending. */
const MAX_UNCOMMITTED = 2 * 1024 * 1024;
const RING = 64;

// ── The log parser (pure) ───────────────────────────────────────────────────

export interface RunnerTiming { promptTok: number; promptMs: number; cachedTok: number; genTok: number; genMs: number }

export type RunnerEvent =
  /** A request. `timing` = the runner's own block; `wallMs`/`path` = its access
   *  line. Either may be absent, never both. `ctxSlot` = the slot's context. */
  | { kind: "request"; at: number; path?: string; wallMs?: number; ctxSlot?: number; timing?: RunnerTiming }
  | { kind: "load"; at: number; ms: number };

/** The HTTP paths that run the model. Everything else (`/api/ps`, `/api/show`, …) is noise. */
const INFERENCE = new Set(["/v1/messages", "/v1/chat/completions", "/v1/completions", "/v1/responses", "/api/chat", "/api/generate"]);

const GIN_RE = /^\[GIN\] (\d{4})\/(\d\d)\/(\d\d) - (\d\d):(\d\d):(\d\d) \|\s*(\d+) \|\s*(\S+) \|\s*\S+ \|\s*(\w+)\s+"([^"]*)"/;
const TIME_RE = /^time=(\S+) /;
const TASK_RE = /\| task (\d+) \|/;
const NEW_PROMPT_RE = /new prompt, n_ctx_slot = (\d+),.*task\.n_tokens = (\d+)/;
const PROMPT_EVAL_RE = /prompt eval time =\s*([\d.]+) ms \/\s*(\d+) tokens/;
const EVAL_RE = /\|\s+eval time =\s*([\d.]+) ms \/\s*(\d+) tokens/;
const STARTED_RE = /msg="llama-server started in ([\d.]+) seconds"/;

/** A Go `time.Duration` string (`56.75µs`, `226.16ms`, `3.39s`, `1m2.5s`) in ms, or null. */
export function parseGoDuration(s: string): number | null {
  const re = /(\d+(?:\.\d+)?)(h|ms|µs|μs|us|ns|m|s)/g;
  let total = 0, seen = 0, m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    seen += m[0].length;
    const v = Number(m[1]);
    total += m[2] === "h" ? v * 3_600_000 : m[2] === "m" ? v * 60_000 : m[2] === "s" ? v * 1000
      : m[2] === "ms" ? v : m[2] === "ns" ? v / 1e6 : v / 1000;
  }
  return seen > 0 && seen === s.length && Number.isFinite(total) ? total : null;
}

interface Block { ctxSlot?: number; total?: number; promptTok: number; promptMs: number; genTok: number; genMs: number }

const timingOf = (b: Block): RunnerTiming => ({
  promptTok: b.promptTok, promptMs: b.promptMs,
  // Only where the block logged the prompt's whole length — else unknown, so 0
  // REUSED rather than a guess (`cachedTok` is "counted where logged").
  cachedTok: b.total != null && b.total >= b.promptTok ? b.total - b.promptTok : 0,
  genTok: b.genTok, genMs: b.genMs,
});

/**
 * Parse whole lines of the server log into events, and say how many BYTES were
 * consumed. Only up to a COMMIT POINT — a timestamped line with no timing block
 * open and none waiting for its access line — so a chunk that ends mid-request
 * is re-read next time rather than half-counted, and a restart resumes exactly.
 *
 * Pairing: a completed block is closed by the next inference access line. One
 * waiting ⇒ one request with both; none ⇒ a wall-only request (no runner
 * timings); several (two models' outputs interleaved) ⇒ each block alone, and
 * the access line's wall time belongs to nobody we can name, so it is dropped.
 * A failed request (status ≥ 400) with no block is not counted.
 */
export function parseRunnerLog(buf: Buffer): { events: RunnerEvent[]; consumed: number } {
  const steps = runnerLogSteps(buf);
  for (;;) { const r = steps.next(); if (r.done) return r.value; }
}

/** The longest stretch of parsing before the hand-back (`tokenscan.ts`'s rule). */
const SLICE_MS = 8;
const breathe = () => new Promise<void>((r) => setImmediate(r));

/**
 * `parseRunnerLog`, handing the event loop back every `SLICE_MS` — the SAME
 * parse (one generator drives both), so the result is identical by
 * construction. This runs on the loop pumping every PTY: a 4 MB chunk of
 * regexes in one go is a stall every live session feels.
 */
export async function parseRunnerLogYielding(buf: Buffer, sliceMs = SLICE_MS): Promise<{ events: RunnerEvent[]; consumed: number }> {
  const steps = runnerLogSteps(buf);
  let since = performance.now();
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
    if (performance.now() - since > sliceMs) { await breathe(); since = performance.now(); }
  }
}

/** Lines between the parser's offers to pause; a pause is only TAKEN past `SLICE_MS`. */
const LINES_PER_STEP = 256;

function* runnerLogSteps(buf: Buffer): Generator<void, { events: RunnerEvent[]; consumed: number }, void> {
  let lines = 0;
  const events: RunnerEvent[] = [];
  let tmp: RunnerEvent[] = [];
  const pending = new Map<string, Block>();
  const done: Block[] = [];
  let consumed = 0;
  let start = 0;
  let lastLoad: { at: number; ms: number } | null = null;
  /** Task ids two runners both had open at once (each `llama-server` counts its
   *  own tasks from 0): their lines cannot be told apart, so they are ignored. */
  const poisoned = new Set<string>();
  while (start < buf.length) {
    if (++lines % LINES_PER_STEP === 0) yield;
    const nl = buf.indexOf(10, start);
    if (nl < 0) break; // a partial last line waits for its newline
    const end = nl + 1;
    const line = buf.toString("utf8", start, nl);
    start = end;
    let stamped = false;
    const task = TASK_RE.exec(line)?.[1];
    if (task !== undefined) {
      let m: RegExpExecArray | null;
      // A block exists only from its `new prompt` line: lines of a task whose
      // start was not read (the first watch begins mid-file) are ignored.
      const b = pending.get(task);
      if (poisoned.has(task)) { /* ignored */ } else if ((m = NEW_PROMPT_RE.exec(line))) {
        if (b) { pending.delete(task); poisoned.add(task); }
        else pending.set(task, { promptTok: 0, promptMs: 0, genTok: 0, genMs: 0, ctxSlot: Number(m[1]), total: Number(m[2]) });
      } else if (!b) { /* not ours */ } else if ((m = PROMPT_EVAL_RE.exec(line))) {
        b.promptMs = Number(m[1]); b.promptTok = Number(m[2]);
      } else if ((m = EVAL_RE.exec(line))) {
        b.genMs = Number(m[1]); b.genTok = Number(m[2]);
      } else if (line.includes("total time =")) {
        done.push(b); pending.delete(task);
      }
    } else if (line.startsWith("[GIN]")) {
      const g = GIN_RE.exec(line);
      if (g) {
        stamped = true;
        const at = new Date(+g[1], +g[2] - 1, +g[3], +g[4], +g[5], +g[6]).getTime();
        const path = g[10].split("?")[0];
        if (g[9] === "POST" && INFERENCE.has(path)) {
          const wallMs = parseGoDuration(g[8]);
          const status = Number(g[7]);
          if (done.length === 1) {
            const b = done[0];
            tmp.push({ kind: "request", at, path, ...(wallMs != null ? { wallMs } : {}), ...(b.ctxSlot != null ? { ctxSlot: b.ctxSlot } : {}), timing: timingOf(b) });
          } else if (done.length === 0) {
            if (status < 400 && wallMs != null) tmp.push({ kind: "request", at, path, wallMs });
          } else {
            for (const b of done) tmp.push({ kind: "request", at, ...(b.ctxSlot != null ? { ctxSlot: b.ctxSlot } : {}), timing: timingOf(b) });
          }
          done.length = 0;
        }
      }
    } else {
      const t = TIME_RE.exec(line);
      if (t) {
        const at = Date.parse(t[1]);
        if (Number.isFinite(at)) {
          stamped = true;
          const s = STARTED_RE.exec(line);
          if (s) {
            const ms = Number(s[1]) * 1000;
            // ollama prints this line twice, identically.
            if (!(lastLoad && Math.abs(lastLoad.at - at) < 50 && lastLoad.ms === ms)) tmp.push({ kind: "load", at, ms });
            lastLoad = { at, ms };
          }
        }
      }
    }
    if (stamped && pending.size === 0 && done.length === 0) {
      events.push(...tmp); tmp = []; consumed = end; poisoned.clear();
    } else if (end - consumed > MAX_UNCOMMITTED) {
      // Something opened and never closed (a format change, a crash mid-request):
      // keep what was whole, drop the open blocks, move on.
      events.push(...tmp); tmp = []; consumed = end; pending.clear(); done.length = 0; poisoned.clear();
    }
  }
  return { events, consumed };
}

// ── Attribution (pure) ──────────────────────────────────────────────────────

export interface PsSample { at: number; models: { name: string; ctx?: number }[] }

function windowAround(atFrom: number, atTo: number, samples: readonly PsSample[], intervalMs: number) {
  let bi = -1, ai = -1;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].at < atFrom) bi = i;
    else if (samples[i].at >= atTo) { ai = i; break; }
  }
  if (bi < 0 || ai < 0) return null;
  // A hole in the sampling (host down, desktop asleep) is not "nothing changed".
  if (samples[ai].at - samples[bi].at > 3 * intervalMs + 1000) return null;
  return { bi, ai };
}

/**
 * Which model served a request that ENDED in the second `at` (the access log's
 * resolution), or null. Candidates are every model ps showed from the last
 * sample before that second to the first one after it. A model load in that
 * window that the samples do not explain (a model loaded and gone between two
 * samples) makes the window untrustworthy ⇒ null. One candidate ⇒ it; several ⇒
 * the one whose context equals the slot's, if exactly one; else null.
 */
export function pickModel(at: number, ctxSlot: number | undefined, samples: readonly PsSample[], loadAts: readonly number[], intervalMs: number): string | null {
  const w = windowAround(at, at + 1000, samples, intervalMs);
  if (!w) return null;
  const before = new Set(samples[w.bi].models.map((m) => m.name));
  const cands = new Map<string, number | undefined>();
  const fresh = new Set<string>();
  for (let i = w.bi; i <= w.ai; i++) {
    for (const m of samples[i].models) {
      cands.set(m.name, m.ctx ?? cands.get(m.name));
      if (!before.has(m.name)) fresh.add(m.name);
    }
  }
  const loads = loadAts.filter((t) => t > samples[w.bi].at && t <= samples[w.ai].at).length;
  if (loads > 0 && fresh.size !== loads) return null;
  if (cands.size === 1) return [...cands.keys()][0];
  if (ctxSlot == null) return null;
  const match = [...cands].filter(([, c]) => c === ctxSlot);
  return match.length === 1 ? match[0][0] : null;
}

/** Which model a load at `at` brought in: the ONE model new in the next sample. */
export function pickLoad(at: number, samples: readonly PsSample[], intervalMs: number): string | null {
  const w = windowAround(at, at, samples, intervalMs);
  if (!w) return null;
  const before = new Set(samples[w.bi].models.map((m) => m.name));
  const fresh = samples[w.ai].models.filter((m) => !before.has(m.name));
  return fresh.length === 1 ? fresh[0].name : null;
}

// ── Folding into days (pure) ────────────────────────────────────────────────

function rowFor(days: LocalUsageDay[], day: string, model: string | null): LocalModelDay {
  let d = days.find((x) => x.day === day);
  if (!d) {
    d = { day, models: [] };
    days.push(d);
    days.sort((a, b) => a.day.localeCompare(b.day));
  }
  let r = d.models.find((m) => m.model === model);
  if (!r) { r = { model }; d.models.push(r); }
  return r;
}

function addInto(days: LocalUsageDay[], day: string, model: string | null, delta: Omit<LocalModelDay, "model">): void {
  const r = rowFor(days, day, model);
  const sum = addModelDay(r, { model, ...delta });
  Object.assign(r, sum);
}

/** Fold one attributed event into the days. */
export function foldEvent(days: LocalUsageDay[], ev: RunnerEvent, model: string | null): void {
  const day = localDayKey(ev.at);
  if (ev.kind === "load") { addInto(days, day, model, { loads: { loads: 1, ms: ev.ms } }); return; }
  const delta: Omit<LocalModelDay, "model"> = {};
  if (ev.timing) {
    delta.compute = { requests: 1, ...ev.timing };
    if (ev.wallMs != null) delta.timed = { requests: 1, ms: ev.wallMs };
  } else if (ev.wallMs != null) {
    delta.untimed = { requests: 1, ms: ev.wallMs };
  } else return;
  if (ev.path) delta.byApi = { [ev.path]: 1 };
  addInto(days, day, model, delta);
}

/**
 * Fold one ps sample (and the machine's memory, when read) into the days.
 * Resident time is the interval since the previous sample — only when that
 * sample showed the same model too, and capped, so a gap is not "resident".
 */
export function foldSample(days: LocalUsageDay[], s: PsSample & { sizes: Record<string, { size: number; vram: number }> }, prev: PsSample | null, mem: MemBreakdown | null, intervalMs: number): void {
  const day = localDayKey(s.at);
  const dt = prev ? Math.min(s.at - prev.at, 3 * intervalMs) : 0;
  const machine = machineOf(mem);
  for (const m of s.models) {
    const sz = s.sizes[m.name] ?? { size: 0, vram: 0 };
    const was = !!prev && prev.models.some((p) => p.name === m.name);
    addInto(days, day, m.name, {
      mem: {
        samples: 1, sumBytes: sz.size, peakBytes: sz.size, sumVram: sz.vram, peakVram: sz.vram,
        residentMs: was && dt > 0 ? dt : 0, ...(m.ctx != null ? { contextLength: m.ctx } : {}),
      },
      ...(machine ? { machine } : {}),
    });
  }
}

function machineOf(mem: MemBreakdown | null): LocalModelDay["machine"] | null {
  if (!mem) return null;
  const used = mem.usedBytes;
  const avail = mem.availableBytes;
  if (used == null || avail == null) return null;
  return {
    samples: 1, usedSum: used, usedPeak: used, availMin: avail, totalBytes: used + avail,
    ...(mem.swapUsedBytes != null ? { swapPeak: mem.swapUsedBytes } : {}), source: mem.source,
  };
}

/** Parse `/api/ps` into a sample with each model's context and sizes. */
export function psSample(at: number, body: unknown): PsSample & { sizes: Record<string, { size: number; vram: number }> } {
  const models = parsePs(body);
  const raw = Array.isArray((body as { models?: unknown })?.models) ? (body as { models: Record<string, unknown>[] }).models : [];
  const sizes: Record<string, { size: number; vram: number }> = {};
  const out: PsSample["models"] = [];
  for (const m of models) {
    const r = raw.find((x) => x?.name === m.name || x?.model === m.name);
    const ctx = typeof r?.context_length === "number" && r.context_length > 0 ? r.context_length : undefined;
    out.push({ name: m.name, ...(ctx != null ? { ctx } : {}) });
    sizes[m.name] = { size: m.size, vram: m.vram };
  }
  return { at, models: out, sizes };
}

// ── The ledger ──────────────────────────────────────────────────────────────

interface Cursor { id: string; offset: number }
/** `drain`: the ROTATED file still being caught up on, one `CHUNK` per tick
 *  (absent in files written before it existed — nothing to drain). */
interface Persisted { v: 1; since: number; cursor: Cursor | null; drain?: Cursor | null; days: LocalUsageDay[]; unresolved: RunnerEvent[] }

/** Events waiting for a ps sample, at most. Past it the OLDEST are counted as
 *  `model: null` now — counted, never dropped, and never guessed onto a model. */
const UNRESOLVED_CAP = 5000;

/** The rotated sibling: `server.log` → `server-1.log`. */
export function rotatedOf(file: string): string {
  const ext = extname(file);
  return join(dirname(file), `${basename(file, ext)}-1${ext}`);
}

async function fileId(file: string): Promise<{ id: string; size: number } | null> {
  try {
    const st = await stat(file);
    const fh = await open(file, "r");
    try {
      const b = Buffer.alloc(Math.min(4096, st.size));
      await fh.read(b, 0, b.length, 0);
      const nl = b.indexOf(10);
      if (nl < 0) return null; // no whole first line yet
      return { id: createHash("sha1").update(b.subarray(0, nl)).digest("hex").slice(0, 16), size: st.size };
    } finally { await fh.close(); }
  } catch { return null; }
}

async function readRange(file: string, from: number, to: number): Promise<Buffer> {
  const fh = await open(file, "r");
  try {
    const b = Buffer.alloc(Math.max(0, to - from));
    const { bytesRead } = await fh.read(b, 0, b.length, from);
    return b.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

export class LocalUsageLedger {
  private path: string;
  private since = Date.now();
  private cursor: Cursor | null = null;
  private drain: Cursor | null = null;
  private days: LocalUsageDay[] = [];
  private unresolved: RunnerEvent[] = [];
  private samples: (PsSample & { sizes: Record<string, { size: number; vram: number }> })[] = [];
  private loadAts: number[] = [];
  private lastSampleAt: number | null = null;
  private reachable: boolean | null = null;
  private log: LocalUsageLog = { readable: false, file: null, reason: "not read yet." };
  private dirty = false;
  private savedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(root: string, private readonly intervalMs = localUsageIntervalMs(), private readonly fetchPs: () => Promise<unknown> = defaultFetchPs) {
    const dir = hostStateDir(root);
    this.path = join(dir, "localusage.json");
    try {
      const p = JSON.parse(readFileSync(this.path, "utf8")) as Persisted;
      if (p?.v === 1) {
        if (Number.isFinite(p.since)) this.since = p.since;
        if (p.cursor && typeof p.cursor.id === "string" && Number.isFinite(p.cursor.offset)) this.cursor = p.cursor;
        if (p.drain && typeof p.drain.id === "string" && Number.isFinite(p.drain.offset)) this.drain = p.drain;
        if (Array.isArray(p.days)) this.days = p.days.filter((d) => d && typeof d.day === "string" && Array.isArray(d.models));
        if (Array.isArray(p.unresolved)) { this.unresolved = p.unresolved; this.capUnresolved(); }
      }
    } catch { /* first run, or unreadable: start a fresh ledger */ }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.tick(), 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One tick: new log bytes, then a ps sample (so every event read has an
   *  "after" sample unless it ended this very second), then attribution. */
  async tick(now = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    let next = this.intervalMs;
    try {
      const events = await this.readLog().catch(() => [] as RunnerEvent[]);
      for (const e of events) if (e.kind === "load") this.loadAts.push(e.at);
      this.unresolved.push(...events);
      let body: unknown = null;
      try { body = await this.fetchPs(); } catch { body = null; }
      this.lastSampleAt = now;
      this.reachable = body != null;
      if (body != null) {
        const s = psSample(now, body);
        const prev = this.samples.length ? this.samples[this.samples.length - 1] : null;
        const mem = s.models.length ? await sampleMemory() : null;
        foldSample(this.days, s, prev, mem, this.intervalMs);
        this.samples.push(s);
        if (this.samples.length > RING) this.samples.splice(0, this.samples.length - RING);
        if (s.models.length) this.dirty = true;
      } else {
        next = this.intervalMs * 4;
      }
      this.resolve(now);
      this.trim();
      if (this.dirty && now - this.savedAt >= SAVE_MS) await this.save(now);
    } finally {
      this.busy = false;
      if (this.timer) { this.timer = setTimeout(() => void this.tick(), next); this.timer.unref?.(); }
    }
  }

  /** Attribute every event that now has a sample after it; one that will never
   *  get one (too old for the ring, or the host was not watching) goes to null. */
  private resolve(now: number): void {
    const keep: RunnerEvent[] = [];
    const lastAt = this.samples.length ? this.samples[this.samples.length - 1].at : -Infinity;
    for (const e of this.unresolved) {
      const endAt = e.kind === "load" ? e.at : e.at + 1000;
      if (lastAt < endAt && now - e.at < 5 * this.intervalMs) { keep.push(e); continue; }
      const model = e.kind === "load"
        ? pickLoad(e.at, this.samples, this.intervalMs)
        : pickModel(e.at, e.ctxSlot, this.samples, this.loadAts, this.intervalMs);
      foldEvent(this.days, e, model);
      this.dirty = true;
    }
    this.unresolved = keep;
    this.capUnresolved();
    const oldest = this.samples.length ? this.samples[0].at : now;
    this.loadAts = this.loadAts.filter((t) => t >= oldest - 60_000);
  }

  /** Hold at most `UNRESOLVED_CAP` events; the oldest past it go in as `model: null`. */
  private capUnresolved(): void {
    const over = this.unresolved.length - UNRESOLVED_CAP;
    if (over <= 0) return;
    for (const e of this.unresolved.splice(0, over)) foldEvent(this.days, e, null);
    this.dirty = true;
  }

  private trim(): void {
    if (this.days.length > KEEP_DAYS) this.days.splice(0, this.days.length - KEEP_DAYS);
  }

  /** Read the log's new bytes (and the end of a file that rotated away). */
  private async readLog(): Promise<RunnerEvent[]> {
    const where = ollamaLogPath();
    if ("reason" in where) { this.log = { readable: false, file: null, reason: where.reason }; return []; }
    const file = where.file;
    const cur = await fileId(file);
    if (!cur) {
      this.log = { readable: false, file, reason: `there is no readable server log at ${file} (ollama writes one when it runs as the desktop app; ${envName("OLLAMA_LOG")} names another).` };
      return [];
    }
    this.log = { readable: true, file, readAt: Date.now() };
    const out: RunnerEvent[] = [];
    if (!this.cursor) {
      // First watch: the ledger starts NOW. Nothing earlier is attributed.
      this.cursor = { id: cur.id, offset: cur.size };
      this.dirty = true;
      return out;
    }
    if (this.cursor.id !== cur.id) {
      // Ollama restarted and rotated the file: the old one is finished from
      // where we were — ONE CHUNK per tick, like the live file (a 200 MB
      // `server-1.log` in one tick stalled the loop for seconds) — and the
      // new one starts at 0.
      const oid = await fileId(rotatedOf(file));
      if (oid && oid.id === this.cursor.id && oid.size > this.cursor.offset) this.drain = { ...this.cursor };
      this.cursor = { id: cur.id, offset: 0 };
      this.dirty = true;
    }
    if (this.drain) out.push(...await this.drainRotated(file));
    if (cur.size < this.cursor.offset) this.cursor.offset = cur.size; // truncated in place
    if (cur.size > this.cursor.offset) {
      const buf = await readRange(file, this.cursor.offset, Math.min(cur.size, this.cursor.offset + CHUNK));
      const { events, consumed } = await parseRunnerLogYielding(buf);
      out.push(...events);
      if (consumed > 0) { this.cursor.offset += consumed; this.dirty = true; }
    }
    return out;
  }

  /**
   * One chunk of the rotated file, from the drain cursor. The drain ends when
   * the file is consumed, when its tail never reaches a commit point (what it
   * held is dropped, as before), or when the file is no longer the one we were
   * reading (rotated AGAIN, or gone — what it held past the cursor is lost and
   * nothing is guessed in its place).
   */
  private async drainRotated(file: string): Promise<RunnerEvent[]> {
    const d = this.drain!;
    const old = rotatedOf(file);
    const oid = await fileId(old);
    if (!oid || oid.id !== d.id || d.offset >= oid.size) { this.drain = null; this.dirty = true; return []; }
    const buf = await readRange(old, d.offset, Math.min(oid.size, d.offset + CHUNK));
    const { events, consumed } = await parseRunnerLogYielding(buf);
    this.dirty = true;
    if (consumed === 0) { this.drain = null; return events; }
    d.offset += consumed;
    if (d.offset >= oid.size) this.drain = null;
    return events;
  }

  /** True while a rotated log is still being caught up on (tests). */
  get draining(): boolean { return this.drain != null; }

  private async save(now: number): Promise<void> {
    const body: Persisted = { v: 1, since: this.since, cursor: this.cursor, drain: this.drain, days: this.days, unresolved: this.unresolved };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify(body));
      await rename(tmp, this.path);
      this.savedAt = now;
      this.dirty = false;
    } catch { /* the next tick tries again; nothing is lost while the process lives */ }
  }

  doc(): LocalUsageDoc {
    const last = this.samples.length ? this.samples[this.samples.length - 1] : null;
    return {
      available: true, runner: "ollama", url: ollamaUrl(), since: this.since,
      lastSampleAt: this.lastSampleAt, reachable: this.reachable,
      loaded: this.reachable && last ? last.models.map((m) => m.name) : [],
      intervalMs: this.intervalMs, log: this.log,
      days: this.days, unattributedWhy: UNATTRIBUTED_WHY,
    };
  }
}

async function defaultFetchPs(): Promise<unknown> {
  const res = await fetch(`${ollamaUrl()}/api/ps`, { signal: AbortSignal.timeout(1500) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── The one instance ────────────────────────────────────────────────────────

let ledger: LocalUsageLedger | null = null;

/** Called once at boot (never under `--doctor`). Off ⇒ nothing is started. */
export function startLocalUsage(root: string): void {
  if (ledger || !localUsageEnabled()) return;
  ledger = new LocalUsageLedger(root);
  ledger.start();
}

/** What `GET /api/localusage` answers. */
export function localUsageDoc(): LocalUsageDoc {
  if (!localUsageEnabled()) {
    return { available: false, reason: `The local runner's ledger is switched off on this desktop (${envName("LOCAL_USAGE")}=0 or ${envName("LOCAL_RUNTIME")}=0).` };
  }
  if (!ledger) return { available: false, reason: "The local runner's ledger has not started on this desktop." };
  return ledger.doc();
}

/** For tests: install a ledger built elsewhere (or none). */
export function setLocalUsageLedger(l: LocalUsageLedger | null): void { ledger = l; }
