/**
 * The context-window readings of a session: the screen gauge and the log's
 * miniature (`checkContext`/`refreshSpark`), the per-model window every graph is
 * scaled against (`ctxWindows`, the one piece of state here), and the two
 * documents read off a conversation's record — the context series and a turn's
 * tool details — for claude's jsonl (`logFor`) and opencode's store (`ocFor`).
 *
 * Moved verbatim out of `sessions.ts` (docs/notes/host-architecture.md, S8).
 * Reaches the rest of the manager only through `core`.
 */
import type { ContextSeriesDoc, ContextWindowSource, Effort, TranscriptToolDetail } from "@waterplane/shared";
import { resolveContextWindow } from "@waterplane/shared";
import { stripAnsi } from "../prompt.js";
import { subagentsDir } from "../agents.js";
import { autoCompactFor } from "../compliance.js";
import { detectContext } from "../context.js";
import { agentCumOf, agentUsage, projectContextLog, sparkOf, updateContextLog, withAgentRuns, type AgentUsage, type SeriesCursor } from "../ctxlog.js";
import { ContextWindowStore } from "../ctxwindow.js";
import { logMtime, toolDetails, transcriptPath } from "../transcript.js";
import { backendContextWindow, namesStoreReader, resolveBackend, storeReaderFor, type BackendDescriptor } from "../backends/index.js";
import type { Session, SessionCore, StoreSession } from "./core.js";
import type { SourceContextSample } from "@waterplane/shared";
import { liveSourceFor } from "../livesources.js";

/** A contributed reader's answer, or `fallback` when it threw: a store that cannot be read is absent. */
function guarded<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

export class CtxSlice {
  /** The most context each model has been SEEN to hold — what makes every
   *  context graph's y axis the same 0–100%. See `ctxwindow.ts`. */
  private ctxWindows: ContextWindowStore;

  constructor(private readonly core: SessionCore, root: string) {
    this.ctxWindows = new ContextWindowStore(root);
  }

  /** Refresh the context-window figures from the current screen (heuristic). */
  checkContext(s: Session): void {
    if (!s.info.running) return;
    // The source rung first (design §2): the backend's own count, when its side
    // channel hands one over. Null ⇒ the ladder below runs exactly as before.
    // When it answers, the screen gauge is not read — two readers of one number
    // would be two opinions about it — while the log's miniature below is a
    // separate fact and still runs.
    const fromSource = this.sourceContext(s);
    // No gauge on screen, no graph off the log — and therefore no figure. The
    // fields stay ABSENT, which the phone renders as "nothing here is measured";
    // a 0% would be a claim about a window nobody stated. (The two halves are
    // separately capable: `refreshSpark` below reads the conversation log, so it
    // is gated on the transcript, not on the meter.)
    if (fromSource === null && !s.backend.caps.contextMeter) {
      if (s.backend.caps.transcript === "claude-jsonl" && this.refreshSpark(s)) this.core.emit("updated", s.info);
      return;
    }
    let changed = fromSource === true;
    if (fromSource === null) {
      const cleaned = stripAnsi(s.scrollback.slice(-6000));
      const ctx = detectContext(cleaned);
      this.core.noteContextHealth(s, cleaned, ctx.leftPct);
      if (ctx.leftPct != null && ctx.leftPct !== s.info.contextLeft) {
        s.info.contextLeft = ctx.leftPct;
        changed = true;
      }
      if (ctx.usedTok != null && (ctx.usedTok !== s.info.contextUsedTok || ctx.totalTok !== s.info.contextTotalTok)) {
        s.info.contextUsedTok = ctx.usedTok;
        s.info.contextTotalTok = ctx.totalTok;
        changed = true;
      }
    }
    if (this.refreshSpark(s)) changed = true;
    if (changed) this.core.emit("updated", s.info);
  }

  /**
   * The context fill from the backend's own `ContextSource` (design §2), written
   * onto the session's gauge fields. Null when the rung does not apply — no live
   * source, no `context` source, or a sample the source could not give — and the
   * caller then takes the old ladder untouched. Otherwise whether a field moved.
   *
   * What is written, and what is NOT:
   *  - `contextUsedTok` is the source's own count, as stated. A non-number, a
   *    negative or a non-finite one is not a reading, so the rung is null.
   *  - The window is `backendContextWindow(backend, model)` — the CONFIGURED
   *    window for the model the sample names (else the session's), never a
   *    guess and never claude's. **A 0 is not a window** (that function already
   *    refuses one), and no window means `contextTotalTok` and `contextLeft`
   *    are ABSENT, not 0% and not a percentage of somebody else's window.
   *  - `contextLeft` only beside a window, clamped to 0–100: a used count past
   *    the configured window is a full window, not a negative one.
   */
  private sourceContext(s: Session): boolean | null {
    const live = liveSourceFor(s.info.id);
    const src = live?.sources.context;
    if (!live || !src) return null;
    let sample: SourceContextSample | null = null;
    try { sample = src.sample(live.session); } catch { sample = null; }
    const used = sample?.usedTok;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return null;
    const model = sample?.model || s.info.model || undefined;
    const window = backendContextWindow(s.backend.id, model);
    const left = window ? Math.max(0, Math.min(100, Math.round(100 * (1 - used / window)))) : undefined;
    const before = [s.info.contextUsedTok, s.info.contextTotalTok, s.info.contextLeft];
    s.info.contextUsedTok = used;
    if (window) s.info.contextTotalTok = window; else delete s.info.contextTotalTok;
    if (left != null) s.info.contextLeft = left; else delete s.info.contextLeft;
    return before[0] !== s.info.contextUsedTok || before[1] !== s.info.contextTotalTok || before[2] !== s.info.contextLeft;
  }

  /**
   * Re-read the conversation log's tail and re-derive the row miniature.
   *
   * Called from the once-a-turn context scan and nowhere else — this is the
   * one place in the app that touches a multi-MB file on a cadence, so it does
   * three things to stay cheap: it takes the CURSOR (only bytes appended since
   * last time are parsed), it does nothing at all when the log has not moved,
   * and it compares the rendered miniature before claiming a change, because
   * `emit("updated")` fans the whole `SessionInfo` out to every attached
   * socket and sixteen unchanged numbers are not news.
   *
   * Returns whether the caller should emit.
   *
   * The session's own budget is judged at the END, whatever the log did
   * (`budgetwatch.ts`): its verdict moves with the spend AND with the clock (a
   * usage reading going stale), and this is the one per-session cadence.
   */
  refreshSpark(s: Session): boolean {
    const moved = this.readSpark(s);
    return this.core.judgeBudget(s) || moved;
  }

  private readSpark(s: Session): boolean {
    // The miniature is built from the CLI's conversation log. No log, no curve —
    // and `detectClaudeId` below must not be asked either: it answers by picking
    // the newest jsonl in a project directory, which for a session that wrote
    // none would be somebody else's conversation.
    if (s.backend.caps.transcript !== "claude-jsonl") return false;
    const cid = s.info.claudeSessionId ?? this.core.detectClaudeId(s);
    if (!cid) return false;
    const path = transcriptPath(s.info.cwd, cid);
    const mtime = logMtime(path);
    if (mtime == null) return false;
    const cur = s.ctxCursor;
    // What the Task tool's agents have spent, first — because THEY move while
    // the main log is asleep. An agent runs for minutes writing only its own
    // file, so gating this behind "has the conversation log moved" would freeze
    // the total for the whole of a fan-out, which is exactly the session the
    // total exists for.
    try { s.agentUse = agentUsage(subagentsDir(s.info.cwd, cid), s.agentUse ?? null); } catch { /* the curve is not worth a throw */ }
    const agentTok = s.agentUse?.tok ?? null;
    // "Nothing moved" is judged against what the SPARK was built from, never
    // against the cursor or the agent tally: both are SHARED with
    // `getContextSeries`, which advances them without rebuilding the spark.
    // Judged against them, a context sheet polling a running fan-out kept the
    // header's Σ frozen minutes behind the turn's own cost foot ($3.42 under a
    // $6.34 prompt) — the sweep always found "nothing new" because the graph
    // had already read it.
    const from = s.sparkFrom;
    if (from && from.path === path && from.mtime === mtime && from.agentTok === agentTok && s.info.contextSpark) return false;
    let next: SeriesCursor | null;
    // Best-effort in the strongest sense: this runs on the idle path of every
    // session, and a graph is not worth taking a turn boundary down for.
    try { next = updateContextLog(path, cur ?? null); } catch { return false; }
    if (!next) return false;
    s.ctxCursor = next;
    // What the newest turn RAN on, beside the launch flags — the one place a
    // `/model` or `/effort` typed since launch becomes visible. Before the
    // spark, which can come out null on a log the turn fields still describe.
    const turnMoved = noteTurnModel(s, next);
    const peak = next.samples.reduce((m, p) => (p.tok > m ? p.tok : m), 0);
    const window = this.noteAndResolveWindow(next.model ?? s.info.model, peak, s.info.contextTotalTok, s.backend.id);
    const spark = sparkOf(next, window.tok, window.from, s.agentUse ?? null);
    if (!spark) return turnMoved;
    // The setting the row miniature's axis tops out at. Absent rather than
    // wrong when the read throws.
    try {
      const r = autoCompactFor(s.info.cwd);
      if (r.value.kind === "size" && r.value.tokens > 0) spark.autoCompactSetTok = r.value.tokens;
    } catch { /* the axis falls back to the window */ }
    s.sparkFrom = { path, mtime, agentTok };
    const before = s.info.contextSpark;
    s.info.contextSpark = spark;
    return turnMoved || !before || JSON.stringify(before) !== JSON.stringify(spark);
  }

  /**
   * The window every context graph is scaled against, and where it came from.
   *
   * The model first, because that is the number that is the SAME for every
   * session running the same model — which is the whole point of the axis. An
   * absolute gauge the TUI actually printed beats it, being a direct
   * observation of this session rather than a table lookup. Neither ⇒ `none`,
   * and the graph says so instead of quietly scaling to its own peak.
   */
  private contextWindow(model: string | null | undefined, screenTok: number | undefined, backendId: string | undefined): { tok: number | null; from: ContextWindowSource } {
    const seen = resolveContextWindow({ model, screenTok, observedTok: this.ctxWindows.get(model) });
    if (seen.from === "screen" || seen.from === "measured") return seen;
    // The BACKEND's configuration, when it states one for this model — ranked
    // below a gauge and a measurement (`ContextWindowSource`'s "config"), above
    // the id table. This is what makes a claude-jsonl session on a non-Anthropic
    // model (`claude-local`) draw an axis at all: the id table only knows
    // claude's ids, so without it the graph had tokens and no window. A 0 or an
    // unprimed catalogue is null here (`backendContextWindow`), and the answer
    // stays the id table's or `none` — never claude's window for a model that
    // is not claude's.
    const cfg = backendContextWindow(backendId, model ?? undefined);
    return cfg ? { tok: cfg, from: "config" } : seen;
  }

  /**
   * Feed a series' peak into the per-model high-water mark, then resolve.
   *
   * One call, because the two must not drift: reading the window without first
   * offering what this very conversation proves would draw a 346k session on a
   * 200k axis for the length of one more turn, every turn.
   */
  private noteAndResolveWindow(model: string | null | undefined, peakTok: number, screenTok: number | undefined, backendId: string | undefined) {
    this.ctxWindows.note(model, peakTok);
    return this.contextWindow(model, screenTok, backendId);
  }

  /** Persist the per-model context-window marks now (SIGTERM). */
  flushContextWindows(): void {
    this.ctxWindows.flush();
  }

  /**
   * The same question as `logFor`, for a backend whose record is a contributed
   * store reader's (opencode's database, for one): is this session one of
   * those, and do we know WHICH conversation?
   *
   * Deliberately a second resolver rather than a third field on `logFor`'s
   * return. `logFor` answers "where is the claude jsonl", and every caller of it
   * builds a PATH from what comes back; a resolver that could hand one of them a
   * `ses_…` would be one `transcriptPath()` away from the exact failure this
   * whole design refuses. The two are asked in order and only one can answer.
   *
   * A CLOSED session resolves too, as long as the row remembers the id — the
   * reader is most wanted in the minute after a session ended.
   */
  storeFor(id: string): StoreSession | null {
    const s = this.core.sessions.get(id);
    if (s) {
      return namesStoreReader(s.backend.caps)
        ? { convId: s.info.backendSessionId, backend: s.backend, reader: storeReaderFor(s.backend.caps), live: s }
        : null;
    }
    const closed = this.core.closedRow(id);
    if (!closed?.backendSessionId) return null;
    let backend: BackendDescriptor;
    try { backend = resolveBackend(closed.launch?.backend); } catch { return null; }
    return namesStoreReader(backend.caps)
      ? { convId: closed.backendSessionId, backend, reader: storeReaderFor(backend.caps), live: null }
      : null;
  }

  /**
   * The context series for a session whose record is a contributed store's
   * (written against opencode's, the first).
   *
   * Same document, same poll contract, three things that are different and all
   * three of them ABSENT rather than approximated:
   *
   *  • **`autoCompactTok` is null.** The store records that a compaction
   *    happened and not the size it fired at. Deriving it from the sample before
   *    the cut would put a measured-looking number on a screen that quotes it —
   *    and that sample is the last REQUEST, not the window at the moment of the
   *    cut. `preTok`/`postTok` on each event are null for the same reason
   *    (`octranscript.ts`'s `foldOcContext`).
   *  • **`turns` is absent.** The claude path counts turns off the log's own
   *    user records; the count that is cheap here would be "user messages in the
   *    window", which is the same number by a different route with no rule
   *    written down for the day the two disagree. Absent, and the graph simply
   *    does not print it.
   *  • **The window comes from the backend's CONFIGURATION**, keyed on the model
   *    the LAST assistant message actually ran under — so a conversation that
   *    switched models mid-way is scaled against the one it switched TO. It
   *    travels as `windowFrom: "config"` so the caption attributes it: this is
   *    what opencode believes it may send, not something anybody watched happen.
   *    An unprimed catalogue, a probe that failed, a provider that reports no
   *    limit (measured: ollama reports `context: 0`) ⇒ `windowTok: null` and
   *    `windowFrom: "none"`, which the graph already renders by plotting tokens
   *    on their own axis and saying so.
   *
   * Nothing here feeds `SessionInfo`: no `contextLeft`, no `contextSpark`, no
   * percentage on a launcher row. `caps.contextMeter` is false for this backend
   * because its TUI prints no gauge, and that stays a statement about the
   * screen — see `backends/opencode.ts`.
   */
  private storeContextSeries(
    id: string,
    st: StoreSession,
    since: number,
  ): ContextSeriesDoc | "unchanged" | null {
    const reader = st.reader;
    if (!st.convId || !reader) return null;
    const convId = st.convId;
    const stamp = guarded(() => reader.updatedAt(convId), null);
    if (stamp != null && since && stamp <= since) return "unchanged";
    const fold = guarded(() => reader.contextSeries(convId), null);
    if (!fold) return null;
    const tok = backendContextWindow(st.backend.id, fold.model ?? undefined);
    return {
      sessionId: id,
      updatedAt: fold.updatedAt,
      samples: fold.samples,
      events: fold.events,
      windowTok: tok,
      windowFrom: (tok ? "config" : "none") as ContextWindowSource,
      ...(fold.model ? { model: fold.model } : {}),
      autoCompactTok: null,
      truncated: fold.truncated,
    };
  }

  /**
   * Where a session's conversation log lives, for both readers of it. A closed
   * session still resolves as long as we remember its conversation id — the
   * reader is most wanted right after a session ended.
   */
  logFor(id: string): { cwd: string; cid?: string; live: Session | null } | null {
    const s = this.core.sessions.get(id) ?? null;
    // A backend that writes no conversation log has no log to locate. Answered
    // null rather than "the newest jsonl in this directory", which is what
    // `detectClaudeId` would hand back — somebody else's conversation, read as
    // this session's.
    if (s && s.backend.caps.transcript !== "claude-jsonl") return null;
    const closed = s ? null : (this.core.closedRow(id) ?? null);
    const cwd = s?.info.cwd ?? closed?.cwd;
    if (!cwd) return null;
    const cid = s
      ? (s.info.claudeSessionId ?? this.core.detectClaudeId(s) ?? undefined)
      : closed?.claudeSessionId;
    return { cwd, cid, live: s };
  }

  /**
   * The inputs/results one turn's tool calls left behind in a `lite` transcript,
   * keyed by tool_use id. Null when the session, the log or the turn is unknown
   * — the reader says "couldn't load" rather than showing an empty box.
   */
  getToolDetails(id: string, turnId: string): Record<string, TranscriptToolDetail> | null {
    const st = this.storeFor(id);
    // Null and not a fallback: the `history` document has no tool calls in it,
    // so there is nothing this could answer from. The reader says "couldn't
    // load" rather than showing an empty box.
    if (st) {
      const { convId, reader } = st;
      return convId && reader ? guarded(() => reader.toolDetails(convId, turnId), null) : null;
    }
    const log = this.logFor(id);
    if (!log?.cid) return null;
    return toolDetails(transcriptPath(log.cwd, log.cid), log.cwd, turnId);
  }

  /**
   * How full this session's context window has been, over time.
   *
   * Same shape as `getTranscript` and for the same reasons: answered from a
   * stat when nothing has moved (`since` → `"unchanged"`), read out of the
   * CLI's own conversation log, and available for a session that is merely
   * CLOSED as long as we still remember its conversation id — the graph is
   * often most wanted right after a session ended at a wall.
   *
   * There is deliberately no history-based fallback. The reader has one because
   * our own record of what we typed is still a conversation; a context series
   * built from what we typed would be a fabrication, and the honest answer when
   * there is no log is null.
   */
  getContextSeries(id: string, since = 0): ContextSeriesDoc | "unchanged" | null {
    const st = this.storeFor(id);
    if (st) return this.storeContextSeries(id, st, since);
    const log = this.logFor(id);
    if (!log?.cid) return null;
    const path = transcriptPath(log.cwd, log.cid);
    const mtime = logMtime(path);
    if (mtime != null && since && mtime <= since) return "unchanged";
    // Shares the live session's cursor, so opening the graph on a session the
    // idle scan has been following costs a stat and nothing else. A CLOSED
    // session has no cursor and pays for one full read, which is the right
    // trade — it happens once and its log is not growing.
    const cur = updateContextLog(path, log.live?.ctxCursor ?? null);
    if (!cur) return null;
    if (log.live) log.live.ctxCursor = cur;
    const parsed = projectContextLog(cur);
    return {
      sessionId: id,
      claudeSessionId: log.cid,
      updatedAt: parsed.mtime,
      samples: parsed.samples,
      events: parsed.events,
      turns: parsed.turns,
      // The auto-compact SETTING as it reads today, drawn beside the measured
      // `autoCompactTok`. Absent rather than wrong when the read throws.
      ...(() => {
        try {
          const r = autoCompactFor(log.cwd);
          return { autoCompactSet: { tokens: r.value.kind === "size" ? r.value.tokens : null, source: r.source, ...(r.raw != null ? { raw: r.raw } : {}) } };
        } catch { return {}; }
      })(),
      // What the conversation's own requests were made of. Always sent where
      // the log was readable at all: the sheet's rule, like the all-sessions
      // screen's, is that a total is never printed without its split, and the
      // two are one pass over one set of records (`tokenTotal(split)` IS
      // `usageTok`).
      split: parsed.split,
      // The model table the samples index into. Sent even where the subagent
      // read failed — the SAMPLES point into it, and a table withheld because
      // the agents could not be listed would break a chart that has nothing to
      // do with them. The agent branch below replaces it with the union.
      models: parsed.models,
      // …and what those requests would have cost at list prices, priced per
      // record in that same pass (`ctxlog.ts`). Sent whenever anything could
      // be priced; the unpriced remainder travels even when nothing could, so
      // the sheet can say "no published rate for this model" rather than
      // drawing a cost section that is silently absent.
      ...(parsed.cost ? { cost: parsed.cost } : {}),
      ...(parsed.unpricedTok > 0 ? { unpricedTok: parsed.unpricedTok } : {}),
      // What the compactions shed, saved and cost. Always sent, zeroed
      // included: a conversation that has never compacted is a fact the sheet
      // says in words, and withholding it there would be indistinguishable
      // from a host too old to have counted.
      compaction: parsed.compaction,
      // The same two facts the row's spark carries, off the full series. The
      // agent tally is the LIVE session's when there is one (it is already
      // warm); a closed session pays one directory read, once.
      ...(() => {
        let use: AgentUsage | null = null;
        try { use = agentUsage(subagentsDir(log.cwd, log.cid!), log.live?.agentUse ?? null); } catch { /* absent, not wrong */ }
        if (log.live) log.live.agentUse = use;
        // `agentSplit` travels with `agentTok` and never without it: the share
        // is only meaningful against a total that contains it, and a split of
        // zeros beside an absent total reads as "the agents spent nothing".
        // `agentCost` travels with `agentSplit` and under the same rule: only
        // beside a total that contains it, and only when it is a cost somebody
        // could compute. The unpriced agent tokens are folded into the doc's
        // own `unpricedTok` above — one figure for "what this screen could not
        // price", never two the reader has to add up.
        if (!use) return {};
        // The roster and the model table are resolved TOGETHER: an agent's
        // model need not be one the conversation itself ever ran, so the index
        // it travels under can only be assigned where both halves are in hand.
        const { models, agents: runs } = withAgentRuns(parsed.models, use.runs);
        // Which of them are still RUNNING, by the same list the session row
        // publishes (`checkAgents` → `readRunningAgents`), so the lane strip
        // and the "agents running" line cannot disagree. A log's last record
        // is not an end — an agent sitting in a long `npm test` writes nothing.
        const live = new Set((log.live?.info.agents ?? []).map((a) => a.id));
        const agents = live.size ? runs.map((a) => (live.has(a.id) ? { ...a, running: true as const } : a)) : runs;
        // What the agents had spent by each instant — the band the spend
        // chart stacks on the parent's curve. Its last point IS `agentTok`.
        const agentCum = agentCumOf(use);
        return {
          ...(agentCum ? { agentCum } : {}),
          usageTok: parsed.usageTok + use.tok,
          agentTok: use.tok,
          agentSplit: use.split,
          models,
          agents,
          ...(use.cost.total > 0 ? { agentCost: use.cost } : {}),
          ...(use.unpriced > 0
            ? { unpricedTok: (parsed.unpricedTok || 0) + use.unpriced }
            : {}),
        };
      })(),
      // The window the y axis calls 100%. From the MODEL, so two sessions'
      // graphs are comparable; see `contextWindow`.
      // The LOG's own model first: it is the authority on what actually ran,
      // and it is the only source a closed session has (there is no live
      // `SessionInfo` to ask, and its graph must keep the same axis).
      ...(() => {
        const model = cur.model ?? log.live?.info.model ?? null;
        const peak = cur.samples.reduce((m, p) => (p.tok > m ? p.tok : m), 0);
        const backendId = log.live?.backend.id ?? this.core.closedRow(id)?.launch?.backend;
        const w = this.noteAndResolveWindow(model, peak, log.live?.info.contextTotalTok, backendId);
        return { windowTok: w.tok, windowFrom: w.from, ...(model ? { model } : {}) };
      })(),
      autoCompactTok: parsed.autoCompactTok,
      coldStarts: parsed.coldStarts,
      truncated: parsed.truncated,
    };
  }
}

const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"] satisfies Effort[];

/**
 * Copy the cursor's newest model and effort onto `SessionInfo.turnModel` /
 * `turnEffort`; true when either moved. An effort word this host does not know
 * is left absent rather than passed on as an `Effort` it is not.
 */
function noteTurnModel(s: Session, cur: SeriesCursor): boolean {
  const model = cur.model ?? undefined;
  const effort = cur.effort && EFFORTS.includes(cur.effort) ? (cur.effort as Effort) : undefined;
  if (s.info.turnModel === model && s.info.turnEffort === effort) return false;
  if (model) s.info.turnModel = model; else delete s.info.turnModel;
  if (effort) s.info.turnEffort = effort; else delete s.info.turnEffort;
  return true;
}
