/**
 * The probe slice of `sidecar.ts` — ONE lookup question asked of this desktop's setup, read-only,
 * through the claude engine (R-metrics-071). The argv, the stream-json reading and the turn and
 * token caps live HERE, so `probe.ts` never names a `claude` flag: another backend is another
 * `runProbeAsk` returning the same `ProbeAsk`.
 *
 * ── Every flag `runSummaryTask` sets, and why this one drops it ──────────────
 *
 * - `--setting-sources user` DROPPED: the project's CLAUDE.md, skills and settings ARE the setup
 *   being measured. Safe only because `runToolTask` refuses a repo Claude Code does not trust
 *   (`trustOf` = the repo the scratch worktree was made from).
 * - `--tools ""` REPLACED by `--tools Read,Grep,Glob,Skill` and the same `--allowedTools`: the
 *   session has to FIND the answer, and none of these writes or runs anything.
 * - `--system-prompt` DROPPED: the CLI's own system prompt is part of what is measured.
 * Added: `--permission-mode default` (the person's user settings may say auto: without it a tool
 * not listed might run), `--strict-mcp-config` (no MCP server: a connector is not a lookup tool),
 * `--max-turns` (the cap; a hit is scored wrong), `--output-format stream-json --verbose` (tool
 * inputs for the call count and the leak check, usage per request for the token cap).
 * `--thinking disabled` is NOT set: the person's sessions think, and the probe measures them.
 *
 * Tap-started only, the estimate shown before the tap, the halt gate (`runHeadlessClaude`) and the
 * process-group kill at the token cap — never scheduled, never fired by a marker.
 */
import { detectHeadlessLimit } from "../limit.js";
import { promptText } from "../prompts.js";
import { usageRecordOf } from "../ctxlog/usagerecord.js";
import { envelopeUsage, runToolTask } from "./sidecarclaude.js";
import { HALT_REFUSAL } from "@waterplane/shared";

/** The read-only tools a probe session may use. */
export const PROBE_TOOLS = "Read,Grep,Glob,Skill";
/** One question's wall clock (the pilot's slowest was 25 s). */
export const PROBE_ASK_TIMEOUT_MS = 300_000;

const PROBE_PROMPT = "Answer this question about the repository in the current working directory. You may only look things up (no edits). Be brief.";
/** The answer contract the grader reads — in code, never overridable. */
const ANSWER_CONTRACT = 'Finish with exactly one final line of the form "ANSWER: <answer>".';

/** The argv for one question. */
export function probeArgv(model: string, maxTurns: number): string[] {
  return [
    "-p", "--model", model,
    "--output-format", "stream-json", "--verbose",
    "--tools", PROBE_TOOLS, "--allowedTools", PROBE_TOOLS,
    "--permission-mode", "default",
    "--strict-mcp-config",
    "--max-turns", String(maxTurns),
  ];
}

/** The prompt for one question (wording overridable via `prompts/probe.md`, the contract not). */
export function probePrompt(question: string): string {
  return `${promptText("probe", PROBE_PROMPT)} ${ANSWER_CONTRACT}\n\nQuestion: ${question}`;
}

interface Usage { in: number; cw: number; cr: number; out: number }
/** The result envelope's aggregate usage and price, through the seam's one envelope reader. */
const envelopeOf = (res: Record<string, unknown>): { usage?: Usage; usd?: number } => {
  const e = envelopeUsage(JSON.stringify({ usage: res.usage, total_cost_usd: res.total_cost_usd }));
  return {
    ...(e.usage ? { usage: { in: e.usage.inTok, cw: e.usage.cacheWrite, cr: e.usage.cacheRead, out: e.usage.outTok } } : {}),
    ...(e.usd != null ? { usd: e.usd } : {}),
  };
};

/** What one ask did, as this engine reports it. Every field the stream did not say is absent. */
export interface ProbeAsk {
  readonly backend: "claude";
  /** No run happened: a refused route, an untrusted repo, halted. */
  readonly refused?: string;
  readonly halted?: boolean;
  /** The account refused (a usage limit). */
  readonly limited?: boolean;
  /** The run failed without an answer (timeout, crash, the token cap kill). */
  readonly error?: string;
  readonly text: string;
  readonly capHit: boolean;
  readonly tools: readonly { name: string; input: unknown }[];
  readonly requests: number;
  readonly usage?: Usage;
  /**
   * Tokens the stream showed per request, for the BUDGET only: a question killed at the cap, timed out
   * or crashed has no result envelope (no `usage`) but did spend. Never an analysed figure.
   */
  readonly spent?: number;
  readonly startTok?: number;
  readonly turns?: number;
  readonly model?: string;
  readonly cli?: string;
  readonly cwd?: string;
  /** The memory directories the CLI attached (`init.memory_paths`) — the leak check allows these. */
  readonly memoryDirs: readonly string[];
  readonly usd?: number;
  readonly ms: number;
}

/**
 * Reads a stream-json run incrementally, keeping only what the probe needs — never the tool
 * results, which can be large. Pure, exported for the fixture tests.
 */
export class ProbeStreamReader {
  private buf = "";
  private perMsg = new Map<string, Usage>();
  private toolIds = new Set<string>();
  readonly tools: { name: string; input: unknown }[] = [];
  init: Record<string, unknown> | null = null;
  result: Record<string, unknown> | null = null;
  startTok: number | undefined;

  push(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.line(line);
    }
  }

  end(): void { if (this.buf.trim()) this.line(this.buf); this.buf = ""; }

  /** Tokens so far, every request counted once at its latest usage. */
  liveTokens(): number {
    let t = 0;
    for (const u of this.perMsg.values()) t += u.in + u.cw + u.cr + u.out;
    return t;
  }

  get requests(): number { return this.perMsg.size || this.msgIds.size; }
  private msgIds = new Set<string>();

  private line(raw: string): void {
    const s = raw.trim();
    if (!s.startsWith("{")) return;
    let l: Record<string, unknown>;
    try { l = JSON.parse(s) as Record<string, unknown>; } catch { return; }
    if (l.type === "system" && l.subtype === "init") { this.init = l; return; }
    if (l.type === "result") { this.result = l; return; }
    if (l.type !== "assistant") return;
    const msg = l.message as { id?: unknown; usage?: unknown; content?: unknown } | undefined;
    const id = typeof msg?.id === "string" ? msg.id : null;
    if (id) this.msgIds.add(id);
    // Every request counted once, at its latest usage (a streamed reply repeats its id per block).
    const rec = usageRecordOf(l);
    if (id && rec) {
      if (this.startTok == null && this.perMsg.size === 0) this.startTok = rec.carried;
      this.perMsg.set(id, { in: rec.input, cw: rec.cacheWrite, cr: rec.cacheRead, out: rec.output });
    }
    if (Array.isArray(msg?.content)) {
      for (const c of msg.content as { type?: unknown; id?: unknown; name?: unknown; input?: unknown }[]) {
        if (c?.type !== "tool_use" || typeof c.name !== "string") continue;
        const tid = typeof c.id === "string" ? c.id : `${id}:${this.tools.length}`;
        if (this.toolIds.has(tid)) continue;
        this.toolIds.add(tid);
        this.tools.push({ name: c.name, input: c.input });
      }
    }
  }
}

export interface ProbeAskRequest {
  /** The scratch worktree. */
  readonly cwd: string;
  /** The repo the worktree was made from: its trust decides (`runToolTask`'s `trustOf`). */
  readonly repo: string;
  readonly model: string;
  readonly question: string;
  readonly maxTurns: number;
  /** Past this many tokens the run's process group is killed and the ask is an error. */
  readonly tokenCap: number;
  readonly timeoutMs?: number;
  /** For tests: the tool-task runner. */
  readonly run?: typeof runToolTask;
}

/** Ask one question. Never throws. */
export async function runProbeAsk(req: ProbeAskRequest): Promise<ProbeAsk> {
  const t0 = Date.now();
  const reader = new ProbeStreamReader();
  const ac = new AbortController();
  const run = await (req.run ?? runToolTask)("probe", {
    cwd: req.cwd,
    args: probeArgv(req.model, req.maxTurns),
    prompt: probePrompt(req.question),
    timeoutMs: req.timeoutMs ?? PROBE_ASK_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    keepBytes: 64 * 1024,
    signal: ac.signal,
    onOut: (chunk) => {
      reader.push(chunk);
      if (!ac.signal.aborted && reader.liveTokens() > req.tokenCap) {
        ac.abort(new Error(`stopped at the per-question cap of ${req.tokenCap} tokens`));
      }
    },
  }, { trustOf: req.repo });
  reader.end();
  const ms = Date.now() - t0;
  const base = { backend: "claude" as const, tools: reader.tools, requests: reader.requests, memoryDirs: [] as string[], ms, capHit: false, text: "" };
  if (run.refused) return { ...base, refused: run.refused };
  if (run.stderr === HALT_REFUSAL) return { ...base, refused: HALT_REFUSAL, halted: true };
  const init = reader.init ?? {};
  const res = reader.result ?? {};
  const mem = init.memory_paths && typeof init.memory_paths === "object" ? Object.values(init.memory_paths as Record<string, unknown>).filter((v): v is string => typeof v === "string") : [];
  const { usage, usd } = envelopeOf(res);
  const ask: ProbeAsk = {
    ...base,
    memoryDirs: mem,
    text: typeof res.result === "string" ? res.result : "",
    capHit: res.subtype === "error_max_turns",
    ...(usage ? { usage } : {}),
    ...(!usage && reader.liveTokens() > 0 ? { spent: reader.liveTokens() } : {}),
    ...(reader.startTok != null ? { startTok: reader.startTok } : {}),
    ...(typeof res.num_turns === "number" ? { turns: res.num_turns } : {}),
    ...(typeof init.model === "string" ? { model: init.model } : {}),
    ...(typeof init.claude_code_version === "string" ? { cli: init.claude_code_version } : {}),
    ...(typeof init.cwd === "string" ? { cwd: init.cwd } : {}),
    ...(usd != null ? { usd } : {}),
  };
  // Ask the detector only when the run gave no answer envelope (or an error one), and hand it that
  // envelope's text and stderr — never the stream tail, whose tool results (a README's own heading) and
  // the model's prose can hold a banner phrase while the question was answered fine.
  const noAnswer = !reader.result || res.is_error === true;
  if (noAnswer && detectHeadlessLimit(typeof res.result === "string" ? res.result : "", run.stderr).blocked) return { ...ask, limited: true, error: "the account refused: a usage limit" };
  if (ac.signal.aborted) return { ...ask, error: String((ac.signal.reason as Error)?.message ?? "stopped") };
  if (run.failed && !reader.result) return { ...ask, error: run.err?.message ?? "the run failed without an answer" };
  if (res.is_error === true && !ask.capHit) return { ...ask, error: `the run ended in an error (${String(res.subtype ?? "unknown")})` };
  return ask;
}
