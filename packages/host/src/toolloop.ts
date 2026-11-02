/**
 * A session stuck in a TOOL LOOP — the pure half (`sessions/loopwatch.ts` is
 * the wiring). Fixture in, verdict out: `packages/host/test/toolloop.test.mjs`.
 *
 * Measured 2026-10-31: a local model under `claude-local` made 499 tool calls
 * in 20 minutes, 473 of them back to back the SAME Grep with the SAME input
 * and the SAME result, saying "I will now search for the correct string" after
 * each. Across 4,000 ordinary session logs the longest such run was 2. So the
 * rule reads exactly that shape and nothing looser: a run of completed tool
 * calls whose name, input AND result are all identical. A test-fix-retest
 * loop changes its result or puts an Edit between; many different Reads
 * differ in input — neither can build a run. Anything that cannot be matched
 * (a result whose call was written before the cursor started) breaks the run:
 * a miss, never a false alarm.
 *
 * A signal, never an interlock: the verdict is a sentence for a person, and
 * the loop keeps running until somebody stops it with the tools that exist.
 * One verdict per run (`told`); only a DIFFERENT call (progress) or a
 * person's prompt re-arms it.
 */
import { createHash } from "node:crypto";

/** At most this many calls waiting for their result are remembered. */
const PENDING_CAP = 64;

export interface LoopState {
  /** tool_use id → name + input key, until its result arrives. */
  pending: Map<string, { name: string; input: string }>;
  /** The current run: one signature, how many in a row, when it began. */
  sig: string | null;
  tool: string | null;
  n: number;
  since: number | null;
  /** The run was already reported; nothing more until it breaks. */
  told: boolean;
}

export interface LoopVerdict { tool: string; n: number; since: number | null }

export function newLoopState(): LoopState {
  return { pending: new Map(), sig: null, tool: null, n: 0, since: null, told: false };
}

/** Key order is not a change. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

const hash = (s: string): string => createHash("sha1").update(s).digest("hex");

function breakRun(st: LoopState): void {
  st.sig = null; st.tool = null; st.n = 0; st.since = null; st.told = false;
}

function stampOf(row: Record<string, unknown>): number | null {
  const t = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * Feed one parsed log row. Only the main conversation counts (a sidechain is
 * an agent's own log). A person's prompt breaks the run; a meta row (a skill's
 * text, a command's output) is neither progress nor a call.
 */
export function feedLoopRow(st: LoopState, raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const row = raw as Record<string, unknown>;
  if (row.isSidechain === true || row.isMeta === true) return;
  const msg = row.message as { content?: unknown } | undefined;
  const content = msg?.content;
  if (row.type === "assistant") {
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (!b || typeof b !== "object" || (b as any).type !== "tool_use") continue;
      const { id, name, input } = b as { id?: unknown; name?: unknown; input?: unknown };
      if (typeof id !== "string" || typeof name !== "string") continue;
      if (st.pending.size >= PENDING_CAP) st.pending.delete(st.pending.keys().next().value as string);
      st.pending.set(id, { name, input: hash(stable(input)) });
    }
    return;
  }
  if (row.type !== "user") return;
  const results = Array.isArray(content) ? content.filter((b) => b && typeof b === "object" && (b as any).type === "tool_result") : [];
  if (!results.length) { breakRun(st); st.pending.clear(); return; } // a person typed
  const at = stampOf(row);
  for (const b of results as Array<{ tool_use_id?: unknown; content?: unknown; is_error?: unknown }>) {
    const call = typeof b.tool_use_id === "string" ? st.pending.get(b.tool_use_id) : undefined;
    if (!call) { breakRun(st); continue; }
    st.pending.delete(b.tool_use_id as string);
    const sig = `${call.name}\u0000${call.input}\u0000${hash(stable(b.content))}\u0000${b.is_error === true}`;
    if (sig === st.sig) { st.n += 1; continue; }
    st.sig = sig; st.tool = call.name; st.n = 1; st.since = at; st.told = false;
  }
}

/** The run, once it reaches `at` calls and has not been reported. `at <= 0` = off. */
export function loopVerdict(st: LoopState, at: number): LoopVerdict | null {
  if (!(at > 0) || st.told || !st.tool || st.n < at) return null;
  return { tool: st.tool, n: st.n, since: st.since };
}

/** The one line the follow-up flag carries. */
export function loopReason(v: LoopVerdict, now: number): string {
  const mins = v.since != null && now > v.since ? Math.floor((now - v.since) / 60_000) : 0;
  const span = mins >= 1 ? ` over ${mins} min` : "";
  return `looks stuck: the same ${v.tool} call ${v.n}× in a row${span}, same result each time — nothing was stopped`;
}
