/**
 * Reading ONE conversation log into its per-file summary, and finding the logs —
 * the half of `tokenstats.ts` that touches the disk, split out so the store and
 * its fold stay under the file cap.
 *
 * Every call here is ASYNC and the parse yields every `SLICE_MS`: a cold scan
 * reading a 200 MB log in one synchronous go stalled a scratch host's event
 * loop for 0.5-2.4 s. The per-line rules are the store's (`tokenstats.ts`'s
 * header has the reasoning: dedupe by `message.id`, skip `<synthetic>`, keep
 * the kinds apart, the cold-rebuild tally behind the same guards), and
 * `tokenscan.test.mjs` pins the numbers equal to the one-buffer reader's.
 */
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { isColdRebuild } from "@waterplane/shared";

/** Six numbers: the four kinds, the 1-hour SUBSET of the cache writes (which is
 *  what the 2x price tier is charged on), and the turn count. Positional because
 *  there are ~9,500 of these and the key names would be most of the file. */
export type Tally = [input: number, output: number, cacheRead: number, cacheWrite: number, cacheWrite1h: number, turns: number];

export const CROSS = "\u0000";
export const crossKey = (hour: string, model: string) => `${hour}${CROSS}${model}`;

export interface FileSummary {
  /** A subagent transcript (`<conversation>/subagents/agent-*.jsonl`) rather
   *  than a conversation. Real spend, but not a conversation somebody had. */
  sub?: 1;
  /** mtime and size when we read it — together, "has this changed". */
  m: number;
  s: number;
  /** The worktree the conversation ran in, from the records' own `cwd`. */
  w?: string;
  /** Turns billed at a non-standard speed (fast mode). Present only when
   *  non-zero — see `scan()` for why it is counted but not priced. */
  f?: number;
  /** The FIRST counted request's input + cache read + cache write: what the
   *  conversation carried before anyone had said much (the always-on context
   *  plus the first prompt). Absent when no request was answered. */
  b?: number;
  /** `<local hour>\0<model id>` → tally, the hour being `YYYY-MM-DDTHH`.
   *  Averages ~3 entries. */
  x: Record<string, Tally>;
  /**
   * The requests in this file that came back to an EXPIRED cache and re-wrote
   * a window they had already paid to cache (`shared/sessioncost.ts`'s
   * `isColdRebuild`) — `<local hour>\0<model id>` → `[count, tok, tok1h]`.
   *
   * Crossed the same way the tally is, and for the same reason: the premium
   * those tokens carry over reading them back is a price, and a price needs
   * the model and the day. Present only when there were any — most files have
   * none, and an empty object per file is ~10k empty objects on disk.
   */
  r?: Record<string, [count: number, tok: number, tok1h: number]>;
}

export const emptyTally = (): Tally => [0, 0, 0, 0, 0, 0];

export function bump(bag: Record<string, Tally>, key: string, v: Tally): void {
  const a = (bag[key] ??= emptyTally());
  for (let i = 0; i < a.length; i++) a[i] += v[i];
}

/** `YYYY-MM-DDTHH` in the LOCAL zone — the hour the person was working.
 *  Slicing the ISO string would bucket a 01:30 turn under the previous UTC day,
 *  and every hour of the corpus under the wrong slot of the clock. */
export function localHour(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
}

/**
 * Bytes per READ of one log. A conversation log is read in slices, never as one
 * buffer: a 200 MB log read, decoded and split in one go was a single
 * synchronous stretch of 0.5-2.4 s — measured delaying a phone's answer by over
 * 200 ms on a scratch host. Lines are cut at the newline BYTE, which never
 * occurs inside a UTF-8 sequence, so every slice decodes exactly as the whole
 * file would have.
 */
export const SCAN_CHUNK = 4 * 1024 * 1024;
/** The longest stretch of parsing before the scan hands the event loop back. */
const SLICE_MS = 8;
const breathe = () => new Promise<void>((r) => setImmediate(r));

/** Every `.jsonl` under a project directory, as paths RELATIVE to it. Depth is
 *  capped: the CLI nests one level (`<conversation>/subagents/`), and a cap is
 *  cheaper than trusting a directory tree we do not own. */
export async function walkLogs(dir: string, rel = "", depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  let ents;
  try { ents = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of ents) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await walkLogs(join(dir, e.name), child, depth + 1));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(child);
  }
  return out;
}

/**
 * Read one conversation log and summarise it. Null when it holds nothing
 * countable — an empty file, or one the CLI created and never wrote to.
 *
 * Read in `chunkBytes` slices (the first `size` bytes, as stat'ed), split at the
 * newline byte, with a yield to the event loop every `SLICE_MS` of parsing. The
 * per-line rules are unchanged from the one-buffer reader and are stateful
 * across lines (dedupe set, previous request, compaction flag), which is why
 * the lines are handed over strictly in order.
 */
export async function summarizeLog(path: string, size: number, mtime: number, chunkBytes = SCAN_CHUNK): Promise<FileSummary | null> {
  const cross: Record<string, Tally> = {};
  const rebuilds: Record<string, [number, number, number]> = {};
  let cwd: string | undefined;
  let fast = 0;
  let first: number | undefined;
  /** What the previous counted request carried — the context that was in the
   *  cache and could have been read back. See `isColdRebuild`. */
  let prevTok = 0;
  /** A compaction boundary since that request: the next write rebuilds a
   *  window that was DISCARDED, not one that expired, and it is already
   *  accounted for as the cost of compacting. */
  let compacted = false;
  // Per-file and exact: 23 of 119,207 records in the measured corpus repeat a
  // message id NON-adjacently, so a "same as the last one" shortcut would be
  // wrong — cheaply, but wrong, and this number is the whole screen.
  const seen = new Set<string>();

  const handle = (line: string): void => {
    if (!line || line.charCodeAt(0) !== 123 /* { */) return;
    // Three quarters of a conversation log is tool results; `JSON.parse` on
    // all of it is the entire cost of the cold scan.
    //
    // The boundary rows are let through by a second substring test rather
    // than by parsing more: without them every post-compaction write reads
    // as a cold rebuild, which is the one error that would make this number
    // look big and be wrong.
    if (!line.includes('"usage"')) {
      if (line.includes('"compact_boundary"')) compacted = true;
      return;
    }
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (row.type !== "assistant") return;
    const msg = row.message as { id?: unknown; model?: unknown; usage?: Record<string, unknown> } | undefined;
    if (!msg || typeof msg !== "object") return;
    // The usage-limit rejection turn: zero usage, and not a turn that ran.
    if (msg.model === "<synthetic>") return;
    const u = msg.usage;
    if (!u || typeof u !== "object") return;
    if (typeof msg.id === "string") {
      if (seen.has(msg.id)) return;
      seen.add(msg.id);
    }
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
    // The 1-hour cache-write tier is priced at 2x input against 1.25x for the
    // 5-minute one, and it was 84% of all writes here — so the split is read
    // rather than assumed. It was present on 100% of records carrying a write;
    // when it is absent the remainder simply prices at the cheaper tier, which
    // is the conservative direction for an estimate.
    const cc = u.cache_creation as Record<string, unknown> | undefined;
    const t: Tally = [
      n(u.input_tokens), n(u.output_tokens),
      n(u.cache_read_input_tokens), n(u.cache_creation_input_tokens),
      cc && typeof cc === "object" ? n(cc.ephemeral_1h_input_tokens) : 0,
      1,
    ];
    if (!(t[0] || t[1] || t[2] || t[3])) return;
    // Fast mode bills at a premium ($10/$50 on Opus 5 rather than $5/$25) and
    // is NOT modelled — nothing in this corpus used it. Counting the turns is
    // what lets the screen say so instead of being quietly 2x low if it ever
    // starts being used.
    if (typeof u.speed === "string" && u.speed !== "standard") fast++;
    if (!cwd && typeof row.cwd === "string") cwd = row.cwd;
    const ts = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
    const key = crossKey(Number.isFinite(ts) ? localHour(ts) : "", typeof msg.model === "string" ? msg.model : "unknown");
    bump(cross, key, t);
    // Same guards, same record, same bucket — so the rebuild tokens are
    // always a SUBSET of the cache writes in the tally beside them, and the
    // two can be shown as a share without a second pass that might disagree.
    if (isColdRebuild(prevTok, { cacheRead: t[2], cacheWrite: t[3] }, { afterCompaction: compacted })) {
      const r = (rebuilds[key] ??= [0, 0, 0]);
      r[0]++; r[1] += t[3]; r[2] += t[4];
    }
    prevTok = t[0] + t[2] + t[3];
    // An output-only first record (no input, no cache) is not the anchor: the
    // first request that carried context is.
    if (first === undefined && prevTok > 0) first = prevTok;
    compacted = false;
  };

  let fh;
  try { fh = await open(path, "r"); } catch { return null; }
  try {
    let carry: Buffer = Buffer.alloc(0);
    let pos = 0;
    let since = performance.now();
    while (pos < size) {
      const want = Math.min(chunkBytes, size - pos);
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      const got = buf.subarray(0, bytesRead);
      const chunk = carry.length ? Buffer.concat([carry, got]) : got;
      const nl = chunk.lastIndexOf(10);
      if (nl < 0) { carry = chunk; continue; }
      carry = chunk.subarray(nl + 1);
      for (const line of chunk.toString("utf8", 0, nl).split("\n")) {
        handle(line);
        if (performance.now() - since > SLICE_MS) { await breathe(); since = performance.now(); }
      }
    }
    // The last line, which has no newline after it (the one-buffer split's final element).
    handle(carry.toString("utf8"));
  } catch { return null; } finally { await fh.close().catch(() => {}); }

  if (!Object.keys(cross).length) return null;
  return {
    m: mtime, s: size, ...(cwd ? { w: cwd } : {}), ...(fast ? { f: fast } : {}), ...(first ? { b: first } : {}), x: cross,
    ...(Object.keys(rebuilds).length ? { r: rebuilds } : {}),
  };
}
