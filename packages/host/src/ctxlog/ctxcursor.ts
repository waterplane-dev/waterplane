/** The context log's cursor: the types, the ranged line reader and the accumulators' blanks and projections. Moved from ctxlog.ts. */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { ColdStarts, CompactionCost, CompactionLedger, ContextEvent, ContextSample, CostBreakdown, SkillLoad, TokenTotals } from "@waterplane/shared";
import { costOf, zeroCost, zeroTotals } from "@waterplane/shared";
import { localDay } from "../convlog.js";

/** The most one read holds in memory. Every log is read forward in chunks of
 *  this, to the end — never from its tail. */
export const MAX_READ = 24 * 1024 * 1024;

export interface ContextLog {
  samples: ContextSample[];
  events: ContextEvent[];
  /** What this conversation has USED: every request's input, cache reads and
   *  cache writes PLUS what each turn generated. Subagents are not in it — they
   *  write their own logs (`agentUsage`), and the caller adds the two. */
  usageTok: number;
  /** The same tokens, by KIND — see `SeriesCursor.split`. `tokenTotal(split)`
   *  is `usageTok` exactly; they are one pass over one set of records. */
  split: TokenTotals;
  /** What those same tokens would have cost at list prices — see
   *  `SeriesCursor.cost`. Null when not one record could be priced. */
  cost: CostBreakdown | null;
  /** Tokens on a model with no published rate, in no cost figure. */
  unpricedTok: number;
  /** What this conversation's compactions shed, saved and cost — see
   *  `CompactionLedger`. Always present, zeroed when none have run. */
  compaction: CompactionLedger;
  /** The turns that came back to an expired cache and re-wrote the window —
   *  see `ColdStarts`. Always present, `count: 0` when none did. */
  coldStarts: ColdStarts;
  /** Every model that ran, descending by tokens — the table `ContextSample.model`
   *  indexes into. See `modelOrder`. */
  models: string[];
  /** Turns the log opened — see `SeriesCursor.turns`. A FLOOR. */
  turns: number;
  /** Newest observed auto-compact's `preTokens`, or null. */
  autoCompactTok: number | null;
  /** The model on the newest real assistant turn — what the window is derived
   *  from when nobody is holding a live `SessionInfo` (a closed session's
   *  graph), and the authority on what actually ran either way. */
  model: string | null;
  /** Every skill body the conversation loaded — see `SkillLoad`. */
  skills: SkillLoad[];
  truncated: boolean;
  mtime: number;
}

/**
 * Read a byte range of the log as whole lines.
 *
 * `consumed` is where the next read may start: the offset just past the last
 * NEWLINE in what we read, never `st.size`. The CLI appends to this file while
 * we are reading it, so a read that stopped mid-record and then resumed from
 * `st.size` would lose the rest of that record for ever — the one way an
 * incremental reader can silently drop a turn.
 */
export function readRange(path: string, from: number): {
  lines: string[]; consumed: number; size: number; mtime: number;
} | null {
  let st;
  try { st = statSync(path); } catch { return null; }
  // At most MAX_READ from `from` on; the caller loops until `consumed`
  // reaches `size` — the whole file, one bounded buffer at a time. Never a
  // tail: a tail is a total that starts in the middle and looks complete.
  const start = from;
  const len = Math.min(st.size - start, MAX_READ);
  if (len <= 0) return { lines: [], consumed: start, size: st.size, mtime: st.mtimeMs };
  const buf = Buffer.allocUnsafe(len);
  const fd = openSync(path, "r");
  try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
  let nl = buf.lastIndexOf(10 /* \n */);
  // One record larger than a whole chunk: step over it rather than re-reading
  // the same MAX_READ bytes for ever. What follows it starts mid-record, which
  // the `{` and JSON.parse guards every caller has already drop.
  if (nl < 0 && len === MAX_READ) nl = len - 1;
  const whole = nl >= 0 ? buf.subarray(0, nl + 1) : Buffer.alloc(0);
  const lines = whole.toString("utf8").split("\n");
  return { lines, consumed: start + whole.length, size: st.size, mtime: st.mtimeMs };
}

export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}


/**
 * Everything one log has told us so far, plus where to resume reading.
 *
 * Held per session because the alternative is re-parsing the whole file every
 * time the graph or the row sparkline wants a fresh answer: `checkContext`
 * fires once per turn, and a 20 MB conversation costs 50 ms to walk. A cursor
 * turns that into "read what was appended", which is a few KB.
 *
 * Raw, pre-downsample. `readContextLog` projects it; the cursor keeps the
 * points so a later projection can pick different ones.
 */
export interface SeriesCursor {
  path: string;
  /** Offset just past the last complete line consumed. */
  consumed: number;
  /** The file's size and mtime when we last looked — a shrink or a rewind
   *  means a different file wearing the same name, so re-read from scratch. */
  size: number;
  mtime: number;
  samples: ContextSample[];
  events: ContextEvent[];
  /**
   * Turns this conversation has run — counted, not derived from `samples`.
   *
   * A sample is one REQUEST: a turn that ran thirteen tools wrote fourteen of
   * them. Reading the series' length as a turn count is how the outline button
   * came to say 24 over a conversation the outline itself listed four turns
   * for. So the user records are counted here instead, by `opensTurn` — the
   * reader's own rule, not a second copy of it.
   *
   * A FLOOR: the parser also opens a turn for a resumed log's pre-prompt tail,
   * and the reader splices in screen-only turns this file never sees. A
   * `truncated` read undercounts further, for the reason the baseline is
   * withheld there. Every screen that prints it words it as "logged so far".
   */
  turns: number;
  /**
   * Tokens this conversation has used — see `ContextLog.usageTok`.
   *
   * A RUNNING counter, not a fold over `samples`: the readings are capped at
   * `RAW_CAP` and downsampled on the way out, so anything derived from them
   * would quietly shrink as the conversation got long — which is the one
   * direction a spend figure must never move. Deduped by `message.id` the same
   * way the readings are, and it includes `output_tokens`, which the readings
   * deliberately exclude (output is not context until the turn after; it IS
   * something that was spent).
   */
  usageTok: number;
  /**
   * `usageTok` broken into the four kinds, accumulated in the same pass.
   *
   * The bare total is the app's most misleading number — measured over this
   * desktop's corpus, 96% of it is the conversation being re-read out of the
   * prompt cache (`shared/tokens.ts`) — and the all-sessions screen has never
   * shown one without its split. This is what lets the per-session screen
   * obey the same rule, in the same `TokenTotals` shape, so neither screen can
   * invent its own accounting.
   *
   * `split.turns` counts assistant REQUESTS, deliberately NOT the `turns`
   * field above, which is what the outline lists: `cacheReading` divides the
   * context by turns on both screens, `tokenstats.ts` counts a request there,
   * and a per-turn figure that meant tool-calls on one screen and prompts on
   * the other would make the same conversation read two ways.
   */
  split: TokenTotals;
  /**
   * `split`'s four kinds as a RUNNING counter, stamped onto every sample.
   *
   * `split` is the whole conversation and `ContextSample.cum` is that same
   * accumulator frozen at each reading — one counter, sampled, for the reason
   * `usageTok` is one counter sampled onto `used`: the series is thinned on the
   * way out, so a cumulative figure the client folds out of what survived ends
   * below the total printed beside it.
   *
   * Not `split` itself, because `split` counts requests the READINGS skip (a
   * turn that carried nothing readable still spent its output) — so this is
   * taken before the reading is pushed and the two end at the same place only
   * when every request produced one.
   */
  cum: TokenTotals;
  /**
   * What `split` would have cost at Anthropic's list prices, accumulated in
   * the same pass and PER RECORD.
   *
   * Per record because that is the only granularity at which the figure is
   * well defined: the rate is a property of the model that ran the request and
   * of the day it ran on, and both change inside one conversation (a session
   * switched from sonnet to opus, a rate that moved). Pricing `split` as a
   * whole afterwards would have to pick one model — `cur.model`, the NEWEST
   * one — and charge the entire conversation at it. That is the plausible
   * wrong number this file exists to refuse, and it is the same reason
   * `tokenstats.ts` prices inside its own loop rather than off its day rows:
   * one of the two screens picking a single rate is how they come to disagree
   * about the same tokens.
   */
  cost: CostBreakdown;
  /**
   * Every model that has run in this conversation, DESCENDING by tokens at
   * projection time — the table `ContextSample.model` indexes into.
   *
   * A table and an index rather than the id on every sample, because the id is
   * ~18 characters against a sample's ~40 and there are up to 1,200 of them.
   * Accumulated in first-seen order here and re-ordered once on the way out:
   * the ORDER is what assigns a colour on the phone, and a colour follows the
   * entity, so it has to be decided over the whole conversation rather than per
   * chart or per visible range.
   */
  models: string[];
  /** Tokens per entry of `models`, for that one re-ordering. */
  modelTok: number[];
  /**
   * Tokens `costOf` refused to price — a model that is not in the rate table.
   *
   * Counted, not charged at zero: a rate table goes stale the week after it is
   * written, and a model missing from it must surface as usage the screen can
   * name. This is what lets the reading say what it left out instead of
   * quietly coming in low.
   */
  unpriced: number;
  /**
   * The compaction ledger, accumulated in this same pass — see
   * `CompactionLedger`.
   *
   * Here rather than folded out of `events` afterwards, because the SAVING is
   * a per-request quantity: it is the shed window summed over every request
   * that ran after the boundary, and `events` records the boundary alone. A
   * later pass could recover it only by walking the samples, which are thinned
   * on the way out — the same reason `cum` is stamped on rather than derived.
   */
  compaction: CompactRows;
  /**
   * The window those compactions shed, per trigger, running.
   *
   * Two counters rather than one, because the ledger is split by trigger and
   * pricing is linear in tokens: the two priced apart sum to exactly the two
   * priced together, so the split costs nothing in accuracy.
   */
  shedAuto: number;
  shedManual: number;
  /**
   * Whose boundary the NEXT request's cache write pays for, if any.
   *
   * The rebuild is charged to the first request after a boundary and to no
   * other, so this is set at the boundary and cleared by that request. A
   * second boundary before any request replaces it: the rebuild that follows
   * is the newer one's, and the older one's is charged to nothing — it was
   * never written.
   */
  pendingRebuild: "auto" | "manual" | null;
  /**
   * What the PREVIOUS request carried, and when — the two facts a cold rebuild
   * is recognised against (`shared/sessioncost.ts`'s `isColdRebuild`).
   *
   * Kept on the cursor rather than read off `samples[len-1]`, because the
   * samples are capped and spliced: a cursor that has just dropped its oldest
   * readings would otherwise compare against whatever survived.
   */
  prevTok: number;
  prevAt: number;
  /** The rebuilds so far, accumulated in this same pass — see `ColdStarts`. */
  cold: { count: number; tok: number; usd: number; premiumUsd: number; lastAt: number; lastTok: number };
  autoCompactTok: number | null;
  /** Newest non-synthetic `message.model`. See `ContextLog.model`. */
  model: string | null;
  /** The same record's top-level `effort` — what that turn ran at. Null when
   *  the CLI did not write one. Feeds `SessionInfo.turnEffort`. */
  effort: string | null;
  /** Skill bodies the log carried, oldest first, capped at `SKILL_CAP`. */
  skills: SkillLoad[];
  truncated: boolean;
  /** Recent `message.id`s, for the streaming-duplicate rule. Bounded — the
   *  duplicates are adjacent, so a short memory is enough and an unbounded Set
   *  on a conversation nobody closes is a leak. */
  seen: Set<string>;
  seenOrder: string[];
}

/**
 * `CompactionCost` with its two money fields always present.
 *
 * The wire shape withholds a zero (a `$0` saving reads as "compacting was
 * pointless"); an accumulator cannot, so the two shapes are deliberately
 * different and `projectCompaction` is the one place that decides which zero
 * becomes an absence.
 */
export type CompactRow = Required<CompactionCost>;
export interface CompactRows { auto: CompactRow; manual: CompactRow; unmeasured: number }

export function blankRow(): CompactRow {
  return { count: 0, shedTok: 0, savedTok: 0, savedUsd: 0, rebuildTok: 0, rebuildUsd: 0 };
}
/** A zeroed rebuild tally. `count: 0` is the claim that none happened, which
 *  is a different thing from an absent field and is never collapsed into one. */
export function blankCold(): SeriesCursor["cold"] {
  return { count: 0, tok: 0, usd: 0, premiumUsd: 0, lastAt: 0, lastTok: 0 };
}

/**
 * The tally as the wire carries it: money ABSENT rather than zero, for the
 * reason every other figure here is absent rather than zero — a `$0` beside a
 * re-write that visibly happened reads as "this was free", when what it means
 * is that no record could be priced.
 */
export function projectCold(c: SeriesCursor["cold"]): ColdStarts {
  return {
    count: c.count,
    tok: c.tok,
    ...(c.usd > 0 ? { usd: c.usd } : {}),
    ...(c.premiumUsd > 0 ? { premiumUsd: c.premiumUsd } : {}),
    ...(c.lastAt > 0 ? { lastAt: c.lastAt, lastTok: c.lastTok } : {}),
  };
}

export function blankCompaction(): CompactRows {
  return { auto: blankRow(), manual: blankRow(), unmeasured: 0 };
}

/**
 * What one request did NOT have to re-send, priced.
 *
 * As CACHE READS, on the model that actually ran the request and the day it
 * ran on — the same per-record rule `cost` follows, and a floor for the reason
 * `CompactionCost.savedUsd` gives: a resumed conversation re-WRITES its prefix
 * at up to twenty times this rate, so the cheapest reading is the one that
 * cannot flatter the feature it reports on.
 */
export function addSaved(row: CompactRow, shed: number, model: string | null, t: number): void {
  row.savedTok += shed;
  const c = costOf({ input: 0, output: 0, cacheRead: shed, cacheWrite: 0, cacheWrite1h: 0 }, model, localDay(t));
  if (c) row.savedUsd += c.total;
}

/** A zero becomes an ABSENCE on the way out — see `CompactRow`. */
export function projectCompaction(c: CompactRows): CompactionLedger {
  const row = (r: CompactRow): CompactionCost => ({
    count: r.count, shedTok: r.shedTok, savedTok: r.savedTok, rebuildTok: r.rebuildTok,
    ...(r.savedUsd > 0 ? { savedUsd: r.savedUsd } : {}),
    ...(r.rebuildUsd > 0 ? { rebuildUsd: r.rebuildUsd } : {}),
  });
  return { auto: row(c.auto), manual: row(c.manual), unmeasured: c.unmeasured };
}

/** Raw readings held. Past this the oldest go and the series says `truncated`. */
export const RAW_CAP = 20_000;
export const EVENT_CAP = 2_000;
export const SEEN_CAP = 512;
/** Skill loads held per log. A conversation that loads more keeps the newest. */
export const SKILL_CAP = 1_000;

/** How the CLI opens a skill body it writes into the log. No quote in it, so
 *  the raw JSON line contains it verbatim — usable as a pre-filter. */
export const SKILL_BODY = "Base directory for this skill: ";

/**
 * A skill body entering the window, or null. The `Skill` tool's result is a
 * meta user record carrying `sourceToolUseID` whose text opens with
 * `SKILL_BODY` and the skill's directory; the name is that directory's last
 * segment. Anything else — a prompt that quotes the phrase, a record with no
 * tool behind it — is null. Undated ⇒ null: a load placed at "now" would be a
 * moment nobody saw.
 */
export function skillLoadOf(row: Record<string, unknown>, t: number | null): SkillLoad | null {
  if (t == null || row.type !== "user" || row.isMeta !== true || typeof row.sourceToolUseID !== "string") return null;
  const content = (row.message as { content?: unknown } | undefined)?.content;
  const first = Array.isArray(content) ? content[0] as { type?: unknown; text?: unknown } | undefined : undefined;
  const text = first && first.type === "text" && typeof first.text === "string" ? first.text : null;
  if (!text || !text.startsWith(SKILL_BODY)) return null;
  const nl = text.indexOf("\n");
  const dir = text.slice(SKILL_BODY.length, nl < 0 ? undefined : nl).trim().replace(/[\\/]+$/, "");
  const name = dir.split(/[\\/]/).pop() ?? "";
  if (!name) return null;
  return { t, name, chars: text.length };
}

export function pushSkill(list: SkillLoad[], s: SkillLoad): void {
  list.push(s);
  if (list.length > SKILL_CAP) list.splice(0, list.length - SKILL_CAP);
}

export function remember(cur: SeriesCursor, id: string): boolean {
  if (cur.seen.has(id)) return false;
  cur.seen.add(id);
  cur.seenOrder.push(id);
  if (cur.seenOrder.length > SEEN_CAP) {
    const gone = cur.seenOrder.shift();
    if (gone !== undefined) cur.seen.delete(gone);
  }
  return true;
}

export function blank(path: string): SeriesCursor {
  return {
    path, consumed: 0, size: 0, mtime: 0,
    samples: [], events: [], turns: 0, usageTok: 0, split: zeroTotals(),
    cost: zeroCost(), unpriced: 0, models: [], modelTok: [], cum: zeroTotals(),
    compaction: blankCompaction(), shedAuto: 0, shedManual: 0, pendingRebuild: null,
    prevTok: 0, prevAt: 0, cold: blankCold(),
    autoCompactTok: null, model: null, effort: null, skills: [], truncated: false,
    seen: new Set(), seenOrder: [],
  };
}

