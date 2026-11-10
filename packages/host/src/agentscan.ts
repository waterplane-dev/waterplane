/**
 * Agent readings, the DISK half: one conversation log (or one subagent log)
 * read into the small summary `agentclass.ts` folds. Same reading discipline as
 * `tokenscan.ts`, for the same measured reason (a 200 MB log read in one go
 * stalled the daemon for seconds): ASYNC, read in `SCAN_CHUNK` slices cut at
 * the newline byte, a yield to the event loop every `SLICE_MS` of parsing,
 * and a SUBSTRING pre-filter so only the few lines that matter are parsed.
 *
 * The usage rules are `ctxlog/usagerecord.ts`'s (`usageRecordOf`: assistant
 * rows only, `<synthetic>` skipped, a streamed reply counted once by
 * `message.id`) — the same record every ledger reads, never a second reading.
 * A tool call is looked for on EVERY assistant row, deduped or not, because a
 * streamed reply writes its blocks on separate rows under one id.
 */
import { open } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { CONTINUED_RE, EDIT_TOOLS, classifyRework, weekOfMs, type AgentLogSummary, type ConvSummary, type WeekTally } from "./agentclass.js";
import { SCAN_CHUNK } from "./tokenscan.js";
import { firstSightIn, usageRecordOf } from "./ctxlog/usagerecord.js";

const SLICE_MS = 8;
const breathe = () => new Promise<void>((r) => setImmediate(r));
/** A Bash command that commits: `git commit`, `git -C dir commit`, `git -c k=v commit`. */
const COMMIT_RE = /\bgit(?:\s+-[Cc]\s+\S+)*\s+commit\b/;
/** The workflow script whose agents are rework. */
const REPAIR_SCRIPT_RE = /review[-_]?repair/i;
/** How many records at the head of a log decide whether it is fresh. */
const HEAD_RECORDS = 40;
/**
 * A copied record is older than the file that holds it. A log whose first record predates the file's
 * birth by more than this was born by copying (a fork), whatever its parent's records name.
 */
const FORK_BIRTH_SLACK_MS = 2 * 60_000;

/** Feed every line of the first `size` bytes to `handle`, in order, yielding as `tokenscan.ts` does. False on a read failure. */
async function eachLine(path: string, size: number, handle: (line: string) => void, chunkBytes = SCAN_CHUNK): Promise<boolean> {
  let fh;
  try { fh = await open(path, "r"); } catch { return false; }
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
    handle(carry.toString("utf8"));
    return true;
  } catch { return false; } finally { await fh.close().catch(() => {}); }
}

const parse = (line: string): Record<string, unknown> | null => {
  try { const r = JSON.parse(line); return r && typeof r === "object" ? r as Record<string, unknown> : null; } catch { return null; }
};
const tsOf = (row: Record<string, unknown>): number =>
  (typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN);
const blocksOf = (row: Record<string, unknown>): unknown[] => {
  const c = (row.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(c) ? c : [];
};

/** The text of a user row a PERSON typed, or null (tool results, meta rows, command wrappers). */
function humanPrompt(row: Record<string, unknown>): string | null {
  if (row.type !== "user" || row.isMeta === true || row.isSidechain === true) return null;
  const c = (row.message as { content?: unknown } | undefined)?.content;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => (b as { type?: unknown })?.type === "tool_result")) return null;
    text = c.map((b) => ((b as { type?: unknown; text?: unknown })?.type === "text" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")).join("\n");
  }
  const t = text.trim();
  if (!t || /^<(command-|local-command-)/.test(t) || t.startsWith("Caveat:")) return null;
  return t;
}

/** Tokens of one usage record into its week's tally. */
function bumpWeek(wk: Record<string, WeekTally>, ts: number, u: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number }): void {
  const w = weekOfMs(ts);
  if (!w) return; // undated: in no week rather than in a wrong one
  const t = (wk[w] ??= [0, 0, 0, 0, 0, 0]);
  t[0] += u.input; t[1] += u.output; t[2] += u.cacheRead; t[3] += u.cacheWrite; t[4] += u.cacheWrite1h; t[5]++;
}

/**
 * Summarise one top-level conversation log. `id` is the file's own session id
 * (its basename). Null when it holds nothing countable.
 */
export async function summarizeConv(path: string, id: string, size: number, mtime: number, chunkBytes?: number, birth?: number): Promise<ConvSummary | null> {
  const firstSight = firstSightIn(new Set<string>());
  const wk: Record<string, WeekTally> = {};
  let cwd: string | undefined;
  let nf: ConvSummary["nf"];
  let head = 0;
  let prompt: string | undefined;
  let title: string | undefined;
  let t0: number | undefined;
  let t1: number | undefined;
  let ex: [number, number, number, number] = [0, 0, 0, 0];
  let edited = false;
  let cp = 0;
  let cm = false;
  /**
   * A fork's copied prefix: the CLI's `--fork-session` and `convfork.ts` copy the parent's
   * records with uuid, message.id and timestamp unchanged and rewrite only `sessionId`; the
   * `session_id` spelling keeps naming the PARENT. So a log whose head names another session
   * is in its prefix until the first record that names THIS one (a raw substring test, so a
   * compaction row, which carries neither spelling, is placed by the rows around it). Prefix
   * rows are the parent's spend, compactions and commits, counted already in the parent's own
   * log: they enter no week, no compaction count and no commit.
   */
  let prefix = false;
  let forked = false;
  const ownMark = `"session_id":"${id}"`;
  /**
   * The second fork test, independent of any field a parent may lack: records are written when
   * the file exists, so a copied prefix carries timestamps from before the file's birth. A birth
   * after the last write (a copy or restore, not a fork) says nothing and is not used. The prefix
   * then ends at the first record stamped within the slack of the birth. One early row alone
   * (a startup attachment, then hours idle before the first prompt) is not a copy: the log is a
   * fork only once a user or assistant row sits before the cut too.
   */
  const cut = birth !== undefined && birth > 0 && birth <= mtime + 1000 ? birth - FORK_BIRTH_SLACK_MS : undefined;
  let stamped = false;
  let pendingFork = false;
  /** Commit calls waiting for their result. */
  const commits = new Set<string>();
  /** Workflow calls that ran a review-repair script, waiting for their run id. */
  const repairCalls = new Set<string>();
  const rr: string[] = [];
  let any = false;

  const handle = (line: string): void => {
    if (!line || line.charCodeAt(0) !== 123 /* { */) return;
    if (prefix && line.includes(ownMark)) { prefix = false; pendingFork = false; }
    let pre: Record<string, unknown> | null = null;
    if (cut !== undefined && (!stamped || prefix)) {
      pre = parse(line);
      const pts = pre ? tsOf(pre) : NaN;
      if (Number.isFinite(pts)) {
        if (!stamped) {
          stamped = true;
          if (pts < cut) { prefix = true; pendingFork = true; }
        } else if (pts >= cut) { prefix = false; pendingFork = false; }
      }
      if (prefix && pendingFork && (pre?.type === "user" || pre?.type === "assistant")) {
        nf ??= "fork"; forked = true; pendingFork = false;
      }
    }
    const isHead = head < HEAD_RECORDS;
    const wantUsage = line.includes('"usage"');
    const wantTitle = line.includes('"aiTitle"');
    const wantPrompt = prompt === undefined && line.includes('"type":"user"');
    const wantResult = (commits.size > 0 || repairCalls.size > 0) && line.includes('"tool_result"');
    if (!prefix && line.includes('"compact_boundary"')) cp++;
    if (!(isHead || wantUsage || wantTitle || wantPrompt || wantResult)) return;
    const row = pre ?? parse(line);
    if (!row) return;
    head++;
    const ts = tsOf(row);
    if (Number.isFinite(ts)) { if (t0 === undefined) t0 = ts; t1 = ts; }
    if (!cwd && typeof row.cwd === "string") cwd = row.cwd;
    if (isHead) {
      if (typeof row.entrypoint === "string" && row.entrypoint.startsWith("sdk")) nf ??= "headless";
      for (const k of ["sessionId", "session_id"] as const) {
        const v = row[k];
        if (typeof v === "string" && v && v !== id) { nf ??= "fork"; forked = true; prefix = true; }
      }
    }
    if (row.type === "ai-title" && typeof row.aiTitle === "string") title = row.aiTitle;
    if (prompt === undefined) {
      const p = humanPrompt(row);
      if (p !== null) {
        prompt = p;
        if (CONTINUED_RE.test(p)) nf ??= "continued";
      }
    }
    if (row.type === "user" && wantResult) {
      for (const b of blocksOf(row)) {
        const r = b as { type?: unknown; tool_use_id?: unknown; is_error?: unknown };
        if (r?.type !== "tool_result" || typeof r.tool_use_id !== "string") continue;
        if (commits.delete(r.tool_use_id) && r.is_error !== true && !prefix) cm = true;
      }
      const runId = (row.toolUseResult as { runId?: unknown } | undefined)?.runId;
      if (typeof runId === "string" && runId.startsWith("wf_")) {
        for (const b of blocksOf(row)) {
          const r = b as { type?: unknown; tool_use_id?: unknown };
          if (r?.type === "tool_result" && typeof r.tool_use_id === "string" && repairCalls.delete(r.tool_use_id)) rr.push(runId);
        }
      }
    }
    if (row.type !== "assistant") return;
    const u = usageRecordOf(row, firstSight);
    if (u && (u.input || u.output || u.cacheRead || u.cacheWrite)) {
      any = true;
      if (!prefix && Number.isFinite(ts)) bumpWeek(wk, ts, u);
      if (!edited) { ex[0] += u.input; ex[1] += u.cacheRead; ex[2] += u.cacheWrite; ex[3]++; }
    }
    for (const b of blocksOf(row)) {
      const tu = b as { type?: unknown; name?: unknown; id?: unknown; input?: unknown };
      if (tu?.type !== "tool_use" || typeof tu.name !== "string") continue;
      if (EDIT_TOOLS.has(tu.name)) edited = true;
      const input = (tu.input ?? {}) as { command?: unknown; scriptPath?: unknown; name?: unknown };
      if (prefix) continue;
      if (tu.name === "Bash" && typeof tu.id === "string" && typeof input.command === "string" && COMMIT_RE.test(input.command)) commits.add(tu.id);
      if (tu.name === "Workflow" && typeof tu.id === "string"
        && [input.scriptPath, input.name].some((v) => typeof v === "string" && REPAIR_SCRIPT_RE.test(v))) repairCalls.add(tu.id);
    }
  };

  if (!await eachLine(path, size, handle, chunkBytes)) return null;
  if (!any && t0 === undefined) return null;
  // A fork's first prompt is the parent's: its own work is a different task, so it is not classed by it.
  const cls: { c: ConvSummary["c"]; word?: string } = forked ? { c: "unknown" } : classifyRework(prompt, title);
  return {
    m: mtime, s: size,
    ...(cwd ? { w: cwd } : {}),
    ...(nf ? { nf } : {}),
    c: cls.c, ...(cls.word ? { cw: cls.word } : {}),
    ...(t0 !== undefined ? { t0 } : {}), ...(t1 !== undefined ? { t1 } : {}),
    ...(edited ? { ex } : {}),
    wk, cp,
    ...(cm ? { cm: 1 as const } : {}),
    ...(rr.length ? { rr } : {}),
  };
}

/** Summarise one subagent log: its tokens by week and its workflow run directory. */
export async function summarizeAgentLog(path: string, rel: string, size: number, mtime: number, chunkBytes?: number): Promise<AgentLogSummary | null> {
  const firstSight = firstSightIn(new Set<string>());
  const wk: Record<string, WeekTally> = {};
  const handle = (line: string): void => {
    if (!line || line.charCodeAt(0) !== 123 || !line.includes('"usage"')) return;
    const row = parse(line);
    if (!row) return;
    const u = usageRecordOf(row, firstSight);
    if (!u || !(u.input || u.output || u.cacheRead || u.cacheWrite)) return;
    bumpWeek(wk, tsOf(row), u);
  };
  if (!await eachLine(path, size, handle, chunkBytes)) return null;
  const wf = /\/workflows\/(wf_[^/]+)\//.exec(`/${rel}`)?.[1];
  return { m: mtime, s: size, ...(wf ? { wf } : {}), wk };
}
