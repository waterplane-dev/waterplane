// Cut from sessioncost.ts (move only): the reading off a context spark
// The one door stays `./sessioncost.js`; this slice imports its siblings directly, never the barrel.

import type { SessionCostReading } from "./costtypes.js";
import { sessionCost, coldFrom, type CacheAge } from "./costreading.js";

/**
 * The same reading straight off a `ContextSpark`, which is what every screen
 * actually holds.
 *
 * Kept here rather than at the call sites so the three fields the spark carries
 * for this are read one way: `pts` is DOWNSAMPLED, so on a conversation that
 * compacted early its first entry is that bucket's PEAK and not the session's
 * first reading — exactly the mistake that would inflate every baseline and
 * quietly understate every multiple. `baseTok` is the true first reading and is
 * carried separately for that reason.
 */
export function sessionCostOf(spark: {
  pts: number[];
  baseTok?: number;
  turns?: number;
  spentTok?: number;
  usageTok?: number;
  agentTok?: number;
} | null | undefined, live?: CacheAge | null): SessionCostReading | null {
  if (!spark || !spark.pts.length) return null;
  const tok = spark.pts[spark.pts.length - 1];
  if (!(tok > 0)) return null;
  return sessionCost({
    tok,
    baseTok: spark.baseTok ?? null,
    turns: spark.turns ?? null,
    spentTok: spark.spentTok ?? null,
    usageTok: spark.usageTok ?? null,
    agentTok: spark.agentTok ?? null,
    cacheCold: coldFrom(live),
  });
}
