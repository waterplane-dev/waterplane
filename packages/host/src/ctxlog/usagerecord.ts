/**
 * ONE reader for the claude CLI's per-reply usage record — the `assistant` row
 * of a conversation log whose `message.usage` says what a request cost.
 *
 * Every ledger that counts the log asks this, so the record's rules are spelled
 * once. They used to be copied by comment ("same as in the series", "as
 * `ctxlog.ts` does") into five readers, and a fix landed in one copy: c3190495
 * taught `tokenscan.ts` that an output-only first record is not the anchor while
 * `backends/overhead.ts` still returned null on it, and never skipped
 * `<synthetic>` at all.
 *
 * The rules:
 * - only `type === "assistant"` rows with a `message.usage` object;
 * - `<synthetic>` is the usage wall's stand-in, written as an assistant turn
 *   with a usage block of zeros — not a request that ran, so never counted
 *   (plotting it puts a drop to zero on the graph at every wall);
 * - the CLI writes one record per content block of a streamed reply, each with
 *   the SAME usage under the same `message.id`: the first sight counts, the rest
 *   are dropped (the caller owns the set — a cursor bounds its own);
 * - a counter that is missing, non-finite or negative reads 0;
 * - `carried` is what the request SENT (fresh input + cache read + cache write,
 *   however it was billed), output excluded: it is not in the window until the
 *   next turn. The conversation's ANCHOR is the first record with `carried > 0`
 *   — an output-only first record carried nothing and is never it.
 *
 * What a caller does with a record (drop all-four-zero, price it, plot it) stays
 * the caller's; so do the substring pre-filters before `JSON.parse` that keep
 * the cold scan cheap — this takes the row already parsed. Whether a SIDECHAIN
 * row belongs is the caller's too: a parent reader skips it, an agent's own log
 * is nothing else.
 */
import { num } from "./ctxcursor.js";

export interface UsageRecord {
  /** `message.id`, the dedupe key; null when the row has none. */
  id: string | null;
  /** The model that ran the request, as logged (raw id); null when absent. */
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** The 1-hour cache-write tier, READ rather than assumed (a subset of `cacheWrite`). */
  cacheWrite1h: number;
  /** `input + cacheRead + cacheWrite`: what this request carried. */
  carried: number;
}

/**
 * One usage record out of a parsed log row, or null when the row is not one
 * (not an assistant row, no usage, `<synthetic>`, or a repeat of an id already
 * seen). `firstSight(id)` answers true the first time an id is offered and
 * records it; without one, nothing is deduped and the caller does it with
 * `rec.id`. Pure apart from what `firstSight` records.
 */
export function usageRecordOf(row: unknown, firstSight?: (id: string) => boolean): UsageRecord | null {
  if (!row || typeof row !== "object" || (row as { type?: unknown }).type !== "assistant") return null;
  const msg = (row as { message?: unknown }).message as { id?: unknown; model?: unknown; usage?: unknown } | undefined;
  if (!msg || typeof msg !== "object") return null;
  if (msg.model === "<synthetic>") return null;
  const u = msg.usage as Record<string, unknown> | undefined;
  if (!u || typeof u !== "object") return null;
  const id = typeof msg.id === "string" ? msg.id : null;
  if (id !== null && firstSight && !firstSight(id)) return null;
  const cc = u.cache_creation as Record<string, unknown> | undefined;
  const input = num(u.input_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheWrite = num(u.cache_creation_input_tokens);
  return {
    id,
    model: typeof msg.model === "string" ? msg.model : null,
    input,
    output: num(u.output_tokens),
    cacheRead,
    cacheWrite,
    cacheWrite1h: cc && typeof cc === "object" ? num(cc.ephemeral_1h_input_tokens) : 0,
    carried: input + cacheRead + cacheWrite,
  };
}

/** A `firstSight` over a plain set: true (and remembered) the first time an id is offered. */
export function firstSightIn(seen: Set<string>): (id: string) => boolean {
  return (id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  };
}

/** Whether a record can be the conversation's anchor: it carried context. */
export const isAnchor = (rec: UsageRecord): boolean => rec.carried > 0;
