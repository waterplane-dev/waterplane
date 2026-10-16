/**
 * What each PROMPT cost: the session's requests, grouped under the turn that
 * opened them.
 *
 * Not a second ledger. The records, the guards and the bag are
 * `ctxupdate.ts`'s, line for line — the same pre-filter, the sidechain and
 * `<synthetic>` refusals, the same bounded duplicate memory (`remember`, over a
 * `blank()` cursor used for nothing else), the same "all four zero is not a
 * request" drop, priced per record on that record's own model and day. So the
 * turns SUM to the cursor's `split` field for field and to its `cost.total` to
 * the float, and `turns.test.mjs` pins both: a per-prompt list that added up to
 * a different number from the headline above it would be the most convincing
 * wrong figure on the screen.
 *
 * What opens a turn is the transcript reader's own `opensTurn` (a typed prompt
 * or a local slash command); a tool result opens nothing. Requests before the
 * first prompt (a resumed log's tail) are turn 0, present only when there were
 * any.
 *
 * Incremental like the context cursor: a `TurnCursor` remembers where it
 * stopped, so a poll reads what was appended, not the whole log.
 */
import type { TokenTotals } from "@waterplane/shared";
import { addTotals, costOf, tokenTotal, zeroTotals } from "@waterplane/shared";
import { statSync } from "node:fs";
import { localDay, stamp } from "../../../host/src/convlog.js";
import { localCommandOf, opensTurn, promptOf } from "../../../host/src/transcript/transcriptlog.js";
import { blank, num, readRange, remember } from "../../../host/src/ctxlog/ctxcursor.js";
import type { SeriesCursor } from "../../../host/src/ctxlog/ctxcursor.js";
import type { TurnCost } from "../protocol.js";

/** What the CLI writes into the log when the person interrupts: a note, never a typed prompt. */
const INTERRUPT = /^\s*\[Request interrupted by user/;

/** How much of a prompt a row quotes. */
const PROMPT_CHARS = 120;

interface TurnAcc {
  n: number;
  /** The opening record's timestamp; null until a request dates it. */
  at: number | null;
  prompt: string;
  requests: number;
  kinds: TokenTotals;
  /** Money from the requests that COULD be priced. */
  pricedUsd: number;
  /** Any request on a model with no published rate. */
  unpriced: boolean;
  unpricedTok: number;
  ctxTok: number | null;
}

/** Where a turn walk stopped, and the turns so far. Opaque to callers: hand it back to `advanceTurns`. */
export interface TurnCursor {
  path: string;
  consumed: number;
  size: number;
  mtime: number;
  /** Only its `seen`/`seenOrder` are used — the context cursor's duplicate rule, by its own function. */
  dedupe: SeriesCursor;
  turns: TurnAcc[];
  opened: number;
  /**
   * What the log's last relevant record says about the last turn: "open" = a typed prompt nobody
   * has answered, or an assistant record that is not a final stop (`tool_use`, or a streamed
   * partial whose `stop_reason` is still null); "final" = anything else; null = none seen yet.
   * Read BEFORE the duplicate rule, because the record that finishes a message repeats its id.
   */
  tail: "open" | "final" | null;
}

const blankTurns = (path: string): TurnCursor =>
  ({ path, consumed: 0, size: 0, mtime: 0, dedupe: blank(path), turns: [], opened: 0, tail: null });

/** One line, no control characters: the excerpt is quoted into prompts and typed into terminals. */
// eslint-disable-next-line no-control-regex
const oneLine = (s: string): string => s.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, PROMPT_CHARS);

/**
 * Advance a turn cursor over what the CLI appended, or build one from scratch.
 * Null only when the file is not there. A file that shrank or went back in time
 * is a different conversation and is read again from the start — the context
 * cursor's rule, so the two never disagree about which records they hold.
 */
export function advanceTurns(path: string, prev?: TurnCursor | null): TurnCursor | null {
  let st;
  try { st = statSync(path); } catch { return null; }
  const reusable = prev && prev.path === path && prev.size > 0
    && !(st.size < prev.size || st.mtimeMs < prev.mtime);
  const cur = reusable ? prev : blankTurns(path);
  let read = readRange(path, cur.consumed);
  if (!read) return null;
  const open = (): TurnAcc | undefined => cur.turns[cur.turns.length - 1];

  for (;;) {
    for (const line of read.lines) {
      // ── ctxupdate.ts's filter and branch order, unchanged ──
      if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
      const maybeTurn = line.includes('"type":"user"') && !line.includes('"type":"tool_result"');
      if (!maybeTurn
        && !line.includes('"usage"') && !line.includes('"compactMetadata"') && !line.includes('"quotaLimits"')) continue;
      let row: Record<string, unknown>;
      try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (row.isSidechain === true) continue;
      if (maybeTurn) {
        // The CLI's own "[Request interrupted by user…]" note is written as a user record, but it is
        // the END of a turn, not a prompt: no new turn, no wait, not counted, not quoted.
        if (INTERRUPT.test(promptOf(row) ?? "")) { cur.tail = "final"; continue; }
        if (opensTurn(row)) {
          cur.opened++;
          // A local slash command (`/model`) may never get a reply, so it does not open a wait.
          cur.tail = promptOf(row) != null ? "open" : "final";
          const text = promptOf(row) ?? localCommandOf(row) ?? "";
          cur.turns.push({
            n: cur.opened, at: stamp(row), prompt: oneLine(text), requests: 0, kinds: zeroTotals(),
            pricedUsd: 0, unpriced: false, unpricedTok: 0, ctxTok: null,
          });
        }
        continue;
      }
      const t = stamp(row);
      if (t == null) continue;
      const meta = row.compactMetadata;
      if (meta && typeof meta === "object") continue;
      const quota = row.quotaLimits as { status?: unknown } | undefined;
      if (quota && typeof quota === "object" && quota.status === "rejected") continue;
      if (row.type !== "assistant") continue;
      const msg = row.message as { id?: unknown; model?: unknown; stop_reason?: unknown; usage?: Record<string, unknown> } | undefined;
      if (!msg || typeof msg !== "object") continue;
      // An absent `stop_reason` is "cannot tell", which must not read as a wait: final.
      cur.tail = "stop_reason" in msg && (msg.stop_reason == null || msg.stop_reason === "tool_use" || msg.stop_reason === "pause_turn") ? "open" : "final";
      if (msg.model === "<synthetic>") continue;
      const usage = msg.usage;
      if (!usage || typeof usage !== "object") continue;
      // `remember` is ctxcursor's bounded memory (`SEEN_CAP` = 512 ids, oldest forgotten first) —
      // the very window the context cursor dedupes with, so a duplicate far enough back to be
      // forgotten is counted by BOTH or by neither, and the turns still sum to the split.
      if (typeof msg.id === "string" && !remember(cur.dedupe, msg.id)) continue;
      const tok = num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens);
      const out = num(usage.output_tokens);
      if (!(tok > 0 || out > 0)) continue;
      const cc = usage.cache_creation as Record<string, unknown> | undefined;
      const bag: TokenTotals = {
        input: num(usage.input_tokens),
        output: out,
        cacheRead: num(usage.cache_read_input_tokens),
        cacheWrite: num(usage.cache_creation_input_tokens),
        cacheWrite1h: cc && typeof cc === "object" ? num(cc.ephemeral_1h_input_tokens) : 0,
        turns: 1,
      };
      // ── the turn this request belongs to ──
      let turn = open();
      if (!turn) {
        // Before the first prompt: turn 0, created only now that it holds something.
        turn = { n: 0, at: t, prompt: "", requests: 0, kinds: zeroTotals(), pricedUsd: 0, unpriced: false, unpricedTok: 0, ctxTok: null };
        cur.turns.push(turn);
      }
      if (turn.at == null) turn.at = t;
      turn.requests++;
      addTotals(turn.kinds, bag);
      const raw = typeof msg.model === "string" ? msg.model : null;
      const c = costOf(bag, raw, localDay(t));
      if (c) turn.pricedUsd += c.total;
      else { turn.unpriced = true; turn.unpricedTok += tokenTotal(bag); }
      if (tok > 0) turn.ctxTok = tok;
    }
    const moved = read.consumed > cur.consumed;
    cur.consumed = read.consumed;
    cur.size = read.size;
    cur.mtime = read.mtime;
    if (!moved || cur.consumed >= cur.size) break;
    const next = readRange(path, cur.consumed);
    if (!next) break;
    read = next;
  }
  return cur;
}

/**
 * The cursor's turns as the wire rows, oldest first, in NEW objects.
 *
 * `costUsd` is null when any request of the turn ran on an unpriced model (a
 * figure that left some of it out would read as the whole), and when the turn
 * made no request at all (a `/model` costs nothing, and `$0` would read as a
 * measurement). `open` rides the last turn only (see `TurnCursor.tail`). `cumCostUsd` is null from the first unpriced turn on, and null
 * while nothing has been priced yet.
 */
export function projectTurns(cur: TurnCursor): TurnCost[] {
  let cum = 0;
  let poisoned = false;
  return cur.turns.map((a, i) => {
    if (a.unpriced) poisoned = true;
    const costUsd = a.unpriced || a.requests === 0 ? null : a.pricedUsd;
    if (costUsd != null) cum += costUsd;
    return {
      n: a.n,
      at: a.at ?? 0,
      prompt: a.prompt,
      requests: a.requests,
      kinds: { ...a.kinds },
      costUsd,
      unpricedTok: a.unpricedTok,
      ctxTok: a.ctxTok,
      cumCostUsd: poisoned || cum <= 0 ? null : cum,
      ...(i === cur.turns.length - 1 && cur.tail === "open" ? { open: true } : {}),
    };
  });
}

/**
 * Every turn of one conversation log, read whole from the start — what each
 * prompt cost, with the context it carried. Empty when the file is missing.
 */
export async function turnCosts(path: string): Promise<TurnCost[]> {
  const cur = advanceTurns(path, null);
  return cur ? projectTurns(cur) : [];
}
