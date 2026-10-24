/**
 * Which of the backend's conversations is THIS session's — the pure ladder behind
 * `HostPluginApi.bindConversation` (plugin contract 2.0). Lifted verbatim from opencode's
 * `ocIdVerdict`/`pickOcSession` (`ownRow` is `createsRecord` here) so every backend that keeps its
 * own conversation store decides the same way. The plugin keeps the queries; this is the decision.
 *
 * It lives in shared because an in-repo extension reaches core only through `@waterplane/shared`.
 */

/** A rung-2 match seen on an EARLIER pass, and when it was seen. */
export interface BindSighting {
  readonly id: string;
  readonly at: number;
}

/** What one discovery pass was handed, and what it remembered from the last. */
export interface BindLook {
  /**
   * Is this session's launch ENTITLED to the structural rung at all? True only where our own spawn
   * wrote a conversation record (`LaunchPlan.createsRecord`: a fresh launch or a fork). False for a
   * bare `--continue` and a re-attach, where "the one fresh conversation in this directory" is by
   * construction somebody ELSE'S.
   */
  readonly createsRecord: boolean;
  /** Rung-1 candidates: fresh top-level conversations in this directory. */
  readonly fresh: readonly string[];
  /** Rung-2 candidates: conversations holding this delivery's prompt, whole-string. */
  readonly prompt: readonly string[];
  /** Ids other live sessions have already adopted. */
  readonly adopted: ReadonlySet<string>;
  /** What rung 2 saw last time, if it saw anything. */
  readonly seen?: BindSighting | null;
  readonly now: number;
}

/** The id to adopt (or null), and the sighting to carry into the next pass. */
export interface BindVerdict {
  readonly id: string | null;
  readonly seen: BindSighting | null;
}

/**
 * How long a rung-2 match must have STOOD before it may be adopted: at the instant a delivery is
 * confirmed on screen the backend has not yet written OUR record, so a sole match can be a
 * stranger's. A hit is remembered and adopted only if a LATER pass still finds it alone.
 */
export const BIND_CONFIRM_MS = 2_000;

/** Exactly one survivor, or nothing. Never "the newest", never "the first". */
export function pickBound(candidates: readonly string[], adopted: ReadonlySet<string>): string | null {
  const left = [...new Set(candidates)].filter((id) => id && !adopted.has(id));
  return left.length === 1 ? left[0]! : null;
}

/** One pass of the id discovery, as a fold over what the store answered. */
export function bindConversation(look: BindLook): BindVerdict {
  if (look.createsRecord) {
    const fresh = pickBound(look.fresh, look.adopted);
    if (fresh) return { id: fresh, seen: null };
  }
  const hit = pickBound(look.prompt, look.adopted);
  if (!hit) return { id: null, seen: null };
  const seen = look.seen && look.seen.id === hit ? look.seen : { id: hit, at: look.now };
  if (look.now - seen.at >= BIND_CONFIRM_MS) return { id: hit, seen: null };
  return { id: null, seen };
}
