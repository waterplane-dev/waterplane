// Cut from sessioncost.ts (move only): cold rebuilds
// The one door stays `./sessioncost.js`; this slice imports its siblings directly, never the barrel.

import { fmtUsd } from "../pricing.js";
import { fmtTok } from "./costwords.js";

// ── The turns that re-wrote a window they had already paid to cache ─────────

/**
 * How much of the previous context a request must re-write before it counts as
 * a rebuild, and how little of it it must read.
 *
 * Both halves are needed, and the second one is the half that took three
 * attempts to get right. `cacheWrite > cacheRead` is NOT this test: every cold
 * resume still reads the tools-and-system preamble, a separate cache entry kept
 * warm by sibling sessions in the same repo and measured at 32.5k-36.8k on this
 * desktop. A 60k conversation coming back cold reads 36.8k and writes 30.6k —
 * write below read, and stone cold. What separates the two cases is whether the
 * read covers the CONVERSATION's own previous context.
 *
 * So `REBUILD_READ` is the real test — the read did not cover what was carried
 * — and it is a HIGH bar, not a half: a warm turn reads back essentially all of
 * it (measured: 359,309 read against 358,973 carried, the read being the
 * larger because the turn before it also grew). Half would have called a 66k
 * conversation warm on a 36.8k preamble read alone, which is the exact case
 * that makes this rule necessary.
 *
 * `REBUILD_WROTE` is then measured against what the read LEFT OVER rather than
 * against the whole window, because the preamble is most of a small
 * conversation and none of a large one.
 *
 * That second half also catches a compaction nobody wrote a boundary for: the
 * window was thrown away, so the request after it writes far less than the gap
 * between what it carried and what it read back, and it is not counted. Two
 * independent defences against the one error that would make this figure look
 * big and be wrong — the boundary flag is the other.
 */
export const REBUILD_WROTE = 0.5;
export const REBUILD_READ = 0.8;

/**
 * Did this request re-write a window it had already cached?
 *
 * `prevTok` is what the PREVIOUS request in the same conversation carried — the
 * context that was in the cache and could have been read back at a tenth of the
 * rate. Absent or zero means there is nothing to have lost: the first request
 * of any conversation writes its baseline, and that is the price of starting
 * anywhere, not a rebuild.
 *
 * `afterCompaction` excludes the one case that looks identical and is not. A
 * compaction drops the window to a fraction, so the request after it writes a
 * small number against a large `prevTok` — the tokens were not re-written, they
 * were thrown away on purpose, and `CompactionLedger` already accounts for that
 * rebuild separately. Counting it here would bill compacting twice.
 */
export function isColdRebuild(
  prevTok: number | null | undefined,
  req: { cacheRead: number; cacheWrite: number },
  opts?: { afterCompaction?: boolean },
): boolean {
  if (opts?.afterCompaction) return false;
  if (prevTok == null || !(prevTok > 0)) return false;
  // Read back nearly everything it carried: warm, whatever it wrote.
  if (req.cacheRead >= prevTok * REBUILD_READ) return false;
  return req.cacheWrite >= (prevTok - req.cacheRead) * REBUILD_WROTE;
}

/**
 * What the rebuilds in one conversation — or on a whole desktop — amount to.
 *
 * Every figure is a FLOOR for the reasons every figure derived from these logs
 * is: a truncated log has rebuilds outside what was read, and a conversation
 * that was forked continues in a file this one cannot see.
 */
export interface ColdStarts {
  /** Requests that re-wrote a cached window. */
  count: number;
  /** Tokens they wrote — the ones that could have been cache reads. */
  tok: number;
  /** What those writes cost at list prices, on each record's own model and
   *  day. Absent when nothing could be priced — never 0, which reads as free. */
  usd?: number;
  /**
   * What they cost ABOVE re-reading the same tokens — the part that a resume
   * inside the hour would not have paid at all.
   *
   * This is the number the feature exists for: `usd` includes tokens the
   * conversation was always going to send, and only the premium is money that
   * the clock, rather than the work, decided to spend.
   */
  premiumUsd?: number;
  /** When the newest one happened, and how much it wrote. */
  lastAt?: number;
  lastTok?: number;
}

/**
 * The rebuilds as a sentence — the ONE wording, on all three screens.
 *
 * Null when there were none: a zero here is not a fact worth a line, it is the
 * normal state of a conversation nobody left sitting overnight.
 *
 * It never says "wasted". A long gap is usually somebody sleeping, and a
 * conversation worth coming back to a day later is worth what it costs to come
 * back to; what this can say is what the gap cost, which is a fact, and leave
 * the judgement to whoever reads it.
 */
export function coldStartText(c: ColdStarts | null | undefined, scope: "session" | "corpus"): string | null {
  if (!c || c.count <= 0 || c.tok <= 0) return null;
  const n = c.count;
  const where = scope === "session"
    ? `${n === 1 ? "One turn" : `${n} turns`} here `
    : `${n === 1 ? "One request" : `${n} requests`} across this desktop `;
  const money = c.premiumUsd != null && c.premiumUsd > 0
    ? ` That is ${fmtUsd(c.premiumUsd)} more than re-reading them would have cost at list prices${c.usd != null && c.usd > 0 ? `, out of ${fmtUsd(c.usd)} for the writes themselves` : ""}.`
    : "";
  return `${where}came back to a cache that had expired and re-WROTE ${fmtTok(c.tok)} tokens instead of re-reading them.${money}`;
}

/**
 * The same fact as a chip: `12 rebuilds`, or null.
 *
 * Tokens rather than money, because the two screens that show a chip already
 * decide their own units — and null rather than `0` for `costChip`'s reason.
 */
export function coldStartChip(c: ColdStarts | null | undefined): string | null {
  return c && c.count > 0 ? `${c.count} re-write${c.count > 1 ? "s" : ""}` : null;
}
