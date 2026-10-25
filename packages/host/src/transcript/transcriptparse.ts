/** The log parsed into the reader's turns and blocks, and a turn's tool details. Moved from transcript.ts. */
import { relative, isAbsolute } from "node:path";
import type { TranscriptBlock, TranscriptDoc, TranscriptToolDetail, TranscriptTurn } from "@waterplane/shared";
import { squash } from "../echo.js";
import { costOf, normalizeModel } from "@waterplane/shared";
import { MAX_TURNS, TOOL_INPUT_CAP, TOOL_RESULT_CAP, TEXT_CAP, oneLine, summarize } from "@waterplane/shared";
import { localDay } from "../convlog.js";
import { agentsMtime, attachAgentSpend, noteRetired } from "../turnagents.js";
import { localCommandOf, localOutputOf, promptOf, queuedPromptOf, readLog, resultText } from "./transcriptlog.js";
import { BOX_ANSWER_LEAD, absorbedOpeners, boxAnswerTable, cliHeldTable, noteQueueOp } from "./transcriptturns.js";
import type { BoxAnswer, CliHeld } from "./transcriptturns.js";

/** A readable one-liner for a tool call, per tool. Falls back to the first
 *  string-ish field so an unknown/MCP tool still says something useful. */
function toolLabel(name: string, input: any, cwd: string): string {
  const rel = (p: unknown): string => {
    const s = String(p ?? "");
    if (!s) return "";
    return isAbsolute(s) && !relative(cwd, s).startsWith("..") ? relative(cwd, s) || "." : s;
  };
  if (!input || typeof input !== "object") return oneLine(String(input ?? ""));
  switch (name) {
    case "Bash":
    case "BashOutput":
      return oneLine(String(input.command || input.description || ""));
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return oneLine(rel(input.file_path || input.notebook_path));
    case "Glob":
      return oneLine(String(input.pattern || ""));
    case "Grep":
      return oneLine(`${input.pattern ?? ""}${input.path ? ` in ${rel(input.path)}` : ""}`);
    case "Task":
    case "Agent":
      return oneLine(String(input.description || input.prompt || ""));
    case "WebFetch":
      return oneLine(String(input.url || ""));
    case "WebSearch":
      return oneLine(String(input.query || ""));
    case "TodoWrite":
      return Array.isArray(input.todos) ? `${input.todos.length} items` : "";
    case "Skill":
      return oneLine(String(input.skill || ""));
    default: {
      for (const k of ["description", "prompt", "query", "command", "path", "url", "name", "file_path"]) {
        if (typeof input[k] === "string" && input[k]) return oneLine(input[k]);
      }
      const first = Object.values(input).find((v) => typeof v === "string" && v);
      return first ? oneLine(String(first)) : "";
    }
  }
}

/** Files a tool call writes to — feeds the outline's "touched" list. */
function touchedFile(name: string, input: any, cwd: string): string | null {
  if (!input || typeof input !== "object") return null;
  if (!/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) return null;
  const p = String(input.file_path || input.notebook_path || "");
  if (!p) return null;
  return isAbsolute(p) && !relative(cwd, p).startsWith("..") ? relative(cwd, p) : p;
}

export const ts = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Parse a conversation log into turns. Returns null when the file is missing.
 * `cwd` only makes paths relative in labels.
 *
 * `detail` decides whether tool inputs/results travel. They are the bulk of the
 * document by a wide margin — a day's work is a handful of KB of prose and many
 * MB of `git diff` output — and the phone is the one client that pays for every
 * one of those bytes twice (once over a flaky tunnel, once in IndexedDB). So the
 * default is `"lite"`: names, labels and ok/error stay, the two big strings are
 * replaced by `omitted: true`, and the reader fetches a turn's pair on demand
 * via `toolDetails()`. `"full"` is the old shape, unchanged.
 */
export function parseTranscript(
  path: string,
  cwd: string,
  detail: "lite" | "full" = "lite",
): Omit<TranscriptDoc, "sessionId" | "source"> | null {
  const log = readLog(path);
  if (!log) return null;
  const lite = detail === "lite";

  const turns: TranscriptTurn[] = [];
  let cur: TranscriptTurn | null = null;
  const tools = new Map<string, Extract<TranscriptBlock, { kind: "tool" }>>();

  /** Open a turn. `prompt` empty = pre-prompt output (a resumed conversation's
   *  tail, a session-start hook reply) — still worth showing, so it gets a turn. */
  const open = (id: string, prompt: string, at?: number): TranscriptTurn => {
    const t: TranscriptTurn = {
      id: id || `t${turns.length + 1}`,
      n: turns.length + 1,
      prompt,
      promptLabel: prompt ? oneLine(prompt) : "(continued)",
      sentAt: at,
      blocks: [],
      toolCount: 0,
      files: [],
      sidechains: 0,
    };
    turns.push(t);
    tools.clear();
    return t;
  };
  const ensure = (at?: number): TranscriptTurn => (cur ??= open("", "", at));
  const absorbed = absorbedOpeners(log.lines);
  const answers: BoxAnswer[] = [];
  const held: CliHeld[] = [];
  // What each turn's requests cost, and the conversation's running total —
  // `ctxlog.ts`'s accounting (dedupe by `message.id`, `<synthetic>` skipped,
  // priced on the record's own model and day). A tail-read log has lost its
  // start, so the running total is withheld rather than short; one unpriced
  // request withholds its turn's figure and every running total after it.
  const billed = new Set<string>();
  const unpricedTurns = new Set<TranscriptTurn>();
  let cum: number | null = log.partial ? null : 0;
  /** Agent id → when the parent last recorded it stopping (`turnagents.ts`). */
  const retired = new Map<string, number>();

  for (const raw of log.lines) {
    const ln = raw.trim();
    if (!ln) continue;
    let rec: any;
    try { rec = JSON.parse(ln); } catch { continue; }
    noteRetired(ln, ts(rec?.timestamp) ?? 0, retired);
    const type = rec?.type;
    if (type !== "user" && type !== "assistant") {
      if (noteQueueOp(rec, held)) continue;
      // mode/ai-title/queue-operation/attachment/… noise — with ONE exception.
      // A prompt the CLI absorbed into the running turn is written as an
      // attachment and as nothing else, so this record is the only place those
      // words exist in the log (`absorbedOpeners`, which is what decides that
      // "and as nothing else" part).
      if (!absorbed.size || !absorbed.has(String(rec.uuid ?? ""))) continue;
      const q = queuedPromptOf(rec);
      if (q == null) continue;
      cur = open(String(rec.uuid ?? ""), q.slice(0, TEXT_CAP), ts(rec.timestamp));
      cur.absorbed = true;
      continue;
    }

    const at = ts(rec.timestamp);
    if (rec.isSidechain) { if (cur) cur.sidechains += 1; continue; } // sub-agent chatter, counted not inlined

    const content = rec.message?.content;
    const parts: any[] = Array.isArray(content) ? content : content == null ? [] : [{ type: "text", text: String(content) }];

    if (type === "user") {
      const results = parts.filter((p) => p?.type === "tool_result");
      if (results.length) {
        for (const r of results) {
          const blk = tools.get(String(r.tool_use_id ?? ""));
          const text = resultText(r.content);
          if (at && (blk?.name === "AskUserQuestion" || text.startsWith(BOX_ANSWER_LEAD))) answers.push({ at, text: squash(text) });
          if (!blk) continue;
          // `ok` is set either way: in a lite document it is the ONLY evidence a
          // result came back at all, and "still running" must not read the same
          // as "text withheld".
          if (!lite) {
            blk.result = text.slice(0, TOOL_RESULT_CAP);
            blk.resultTruncated = text.length > TOOL_RESULT_CAP;
          }
          blk.ok = r.is_error !== true;
        }
        if (cur && at) cur.endedAt = at;
        continue;
      }
      // A local command's OUTPUT, which the CLI writes as its own record right
      // after the envelope. It belongs to the turn that envelope opened and to
      // no other: attached to whatever turn happens to be current it would
      // print `/context`'s table under an unrelated prompt.
      const out = localOutputOf(rec);
      if (out != null) {
        if (cur?.local === "log") {
          if (out) cur.blocks.push({ kind: "screen", text: out.slice(0, TEXT_CAP) });
          if (at) cur.endedAt = at;
          continue;
        }
        // No envelope above it — plumbing for something else. Dropped exactly
        // as before rather than opened as a turn with no command on it.
        continue;
      }
      const cmd = localCommandOf(rec);
      if (cmd != null) {
        cur = open(String(rec.uuid ?? ""), cmd, at);
        cur.local = "log";
        continue;
      }
      const text = promptOf(rec);
      if (text == null) continue;
      cur = open(String(rec.uuid ?? ""), text.slice(0, TEXT_CAP), at);
      continue;
    }

    // assistant
    const t = ensure(at);
    for (const p of parts) {
      if (p?.type === "text" && String(p.text ?? "").trim()) {
        t.blocks.push({ kind: "text", text: String(p.text).slice(0, TEXT_CAP) });
      } else if (p?.type === "thinking" && String(p.thinking ?? "").trim()) {
        t.blocks.push({ kind: "thinking", text: String(p.thinking).slice(0, TEXT_CAP) });
      } else if (p?.type === "tool_use") {
        const name = String(p.name ?? "tool");
        // The plan an `ExitPlanMode` call put to you is PROSE, the very thing a
        // reader opens the conversation to read — not a tool input to fold away
        // behind a row (a `lite` document would not even carry it).
        if (name === "ExitPlanMode" && typeof p.input?.plan === "string" && p.input.plan.trim()) {
          t.blocks.push({ kind: "text", text: String(p.input.plan).slice(0, TEXT_CAP) });
        }
        let input: string | undefined;
        if (!lite) {
          try {
            const s = JSON.stringify(p.input, null, 1);
            if (s) input = s.length > TOOL_INPUT_CAP ? s.slice(0, TOOL_INPUT_CAP) + "\n…" : s;
          } catch { /* unserializable input — the label still carries the gist */ }
        }
        const blk: Extract<TranscriptBlock, { kind: "tool" }> = {
          kind: "tool",
          id: String(p.id ?? `${t.id}:${t.toolCount}`),
          name,
          label: toolLabel(name, p.input, cwd),
          input,
          ...(lite ? { omitted: true } : null),
        };
        t.blocks.push(blk);
        tools.set(blk.id, blk);
        t.toolCount += 1;
        if (name === "Task" || name === "Agent") {
          const kind = typeof p.input?.subagent_type === "string" && p.input.subagent_type.trim()
            ? p.input.subagent_type.trim() : "(no type)";
          const row = (t.agentTypes ??= []).find((a) => a.type === kind);
          if (row) row.n += 1; else t.agentTypes.push({ type: kind, n: 1 });
        }
        const f = touchedFile(name, p.input, cwd);
        if (f && !t.files.includes(f)) t.files.push(f);
      }
    }
    if (at) t.endedAt = at;
    const req = requestOf(rec, billed);
    if (req) {
      if (req.ctx > 0) t.ctxTok = req.ctx;
      // The split behind `costUsd`, off the same deduped record.
      const k = (t.tokens ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      k.input += req.bag.input;
      k.output += req.bag.output;
      k.cacheRead += req.bag.cacheRead;
      k.cacheWrite += req.bag.cacheWrite;
      const c =costOf(req.bag, req.model, localDay(at ?? Date.now()));
      if (req.model) {
        const id = normalizeModel(req.model) ?? req.model;
        let m = (t.models ??= []).find((x) => x.id === id);
        if (!m) { m = { id, tok: 0 }; t.models.push(m); }
        m.tok += req.ctx + req.bag.output;
        if (c) m.costUsd = (m.costUsd ?? 0) + c.total;
      }
      if (c && !unpricedTurns.has(t)) t.costUsd = (t.costUsd ?? 0) + c.total;
      if (!c) { unpricedTurns.add(t); delete t.costUsd; cum = null; }
      if (c && cum != null) cum += c.total;
      if (cum != null) t.cumCostUsd = cum;
      else delete t.cumCostUsd;
    }
  }

  for (const t of turns) t.summary = summarize(t.blocks);
  attachAgentSpend(turns, path, retired, log.partial);
  const dropped = Math.max(0, turns.length - MAX_TURNS);
  const kept = dropped ? turns.slice(dropped) : turns;

  const doc = {
    turns: kept,
    truncated: log.partial || dropped > 0,
    bytes: log.bytes,
    // An agent writing while the parent sleeps moved this document's footer.
    updatedAt: Math.max(log.mtime, agentsMtime(path)),
    detail,
  };
  if (answers.length) boxAnswerTable.set(doc, answers);
  if (held.length) cliHeldTable.set(doc, held);
  return doc;
}

/**
 * One billable request out of an assistant record, or null.
 *
 * The CLI writes one record per content block of a streamed reply, each
 * carrying the SAME usage under the same `message.id` — counted once, by the
 * `seen` set, as `ctxlog.ts` does. `<synthetic>` is the usage-wall stand-in
 * with a usage block of zeros; a record whose four counters are all zero is
 * not a request that ran.
 */
function requestOf(rec: any, seen: Set<string>): {
  bag: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number };
  model: string | null;
  ctx: number;
} | null {
  const msg = rec?.message;
  const usage = msg?.usage;
  if (!usage || typeof usage !== "object" || msg.model === "<synthetic>") return null;
  if (typeof msg.id === "string") {
    if (seen.has(msg.id)) return null;
    seen.add(msg.id);
  }
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const cc = usage.cache_creation;
  const bag = {
    input: n(usage.input_tokens),
    output: n(usage.output_tokens),
    cacheRead: n(usage.cache_read_input_tokens),
    cacheWrite: n(usage.cache_creation_input_tokens),
    cacheWrite1h: cc && typeof cc === "object" ? n(cc.ephemeral_1h_input_tokens) : 0,
  };
  const ctx = bag.input + bag.cacheRead + bag.cacheWrite;
  if (ctx <= 0 && bag.output <= 0) return null;
  return { bag, model: typeof msg.model === "string" ? msg.model : null, ctx };
}

/**
 * The inputs/results a `lite` parse left out, for ONE turn, keyed by tool_use id.
 *
 * Keyed by turn id (the prompt record's uuid) rather than turn number because a
 * number is a position in the read window: the log grows, the tail-read slides,
 * and turn 7 is a different turn than it was a minute ago. The uuid is whatever
 * the CLI wrote and never moves.
 *
 * Returns null when the log or the turn is gone — the reader says so rather than
 * showing an empty box. Costs a full re-parse, which is why it is on demand:
 * nobody expands every tool call in a conversation.
 */
export function toolDetails(
  path: string,
  cwd: string,
  turnId: string,
): Record<string, TranscriptToolDetail> | null {
  const parsed = parseTranscript(path, cwd, "full");
  if (!parsed) return null;
  const turn = parsed.turns.find((t) => t.id === turnId);
  if (!turn) return null;
  const out: Record<string, TranscriptToolDetail> = {};
  for (const b of turn.blocks) {
    if (b.kind !== "tool") continue;
    out[b.id] = { input: b.input, result: b.result, ok: b.ok, resultTruncated: b.resultTruncated };
  }
  return out;
}

