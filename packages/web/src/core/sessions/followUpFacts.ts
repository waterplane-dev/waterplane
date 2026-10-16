/**
 * The follow-up flag as a FILTER and a COUNT (R-sessions-045) — the pure half.
 *
 * `isFlagged` is the ONE bucketing predicate: the launcher's `followup` cut
 * (`matchesFilterKind`), the per-repo chip's number and the bulk close's
 * spared set all read it, so the number on a chip is exactly the rows its tap
 * shows. Who set a flag never changes WHETHER it counts — only the colour.
 *
 * No React — `followUpFacts.test.mjs` under `node --test`.
 */
import type { FollowUpBy, SessionInfo } from "@waterplane/shared";

/** Is this session flagged for follow up — by anyone. */
export const isFlagged = (s: SessionInfo): boolean => !!s.followUp;

/**
 * A chip's colour: the setter when every flag it counts has the same one, else
 * `mixed` (drawn in the text colour — no one of the three would be true).
 */
export type FlagTone = FollowUpBy | "mixed";

export interface FlagCount { n: number; tone: FlagTone }

function add(c: FlagCount | undefined, by: FollowUpBy): FlagCount {
  if (!c) return { n: 1, tone: by };
  return { n: c.n + 1, tone: c.tone === by ? by : "mixed" };
}

/** Flagged sessions per repo, with the colour their chip wears. */
export function flaggedByRepoOf(sorted: readonly SessionInfo[], repoName: (s: SessionInfo) => string): Map<string, FlagCount> {
  const m = new Map<string, FlagCount>();
  for (const s of sorted) {
    if (!isFlagged(s)) continue;
    const k = repoName(s);
    m.set(k, add(m.get(k), s.followUp!.by));
  }
  return m;
}

/** Every repo's flags as one count — the launcher head's chip. Null when none. */
export function flaggedTotalOf(byRepo: ReadonlyMap<string, FlagCount>): FlagCount | null {
  let out: FlagCount | null = null;
  for (const c of byRepo.values()) {
    out = out ? { n: out.n + c.n, tone: out.tone === c.tone ? c.tone : "mixed" } : { ...c };
  }
  return out;
}

/** A count chip's title: how many, in which repo, and that the tap is the cut. */
export function flaggedChipTitle(n: number, repo?: string): string {
  return `${n} session${n === 1 ? "" : "s"} flagged for follow up${repo ? ` in ${repo}` : ""} — tap to show only ${n === 1 ? "that one" : "those"}`;
}
