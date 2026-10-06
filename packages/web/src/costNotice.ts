/**
 * The one piece of real logic behind the session-cost toast (`App.tsx`'s
 * effect beside `sessionCostOf`): whether crossing into a cost LEVEL for this
 * session is worth telling the user about, out of the pure JSX effect it used
 * to live inside where nothing could pin it.
 *
 * The rule, unchanged from the effect it was lifted out of:
 *  - once per session per LEVEL STEP UP — a re-render at the same level must
 *    not re-fire, which is why the caller checks BEFORE mutating anything;
 *  - never on the way down — a session that cools off (a fresh compaction, a
 *    forked-and-reset conversation) does not get re-announced climbing back
 *    to a level it already crossed;
 *  - bounded at 60 remembered sessions, oldest evicted first — this is a note
 *    about the current boot, not a ledger, and `Object.keys` on a
 *    plain object walks in INSERTION order, which is what makes "oldest"
 *    mean anything without a separate timestamp per entry.
 *
 * No local-module value imports here on purpose — the web unit-test layer
 * (`npm run test:unit`) runs this straight off the TypeScript with node's type
 * stripping, and this file must never end up pulling in DOM or JSX.
 */
import type { SessionCostLevel } from "@waterplane/shared";

/** How far along the ladder each level sits — comparable with `>=`. */
const RANK: Record<SessionCostLevel, number> = { fresh: 0, warm: 1, heavy: 2, steep: 3 };

/** How many sessions' levels this remembers at once. Sessions are per boot. */
const MAX_REMEMBERED = 60;

export interface NoticeVerdict {
  /** Whether this crossing is worth a toast. */
  notice: boolean;
  /**
   * The map to persist afterward — unchanged (same reference) when `notice`
   * is false, so a caller that skips writing on a no-op loses nothing.
   */
  next: Record<string, string>;
}

/**
 * `seen` is `{ [sessionId]: SessionCostLevel }`, the last level a session was
 * already noticed at. Reassigning an EXISTING key's value in a spread keeps
 * its original enumeration position — which is what makes eviction below
 * "oldest first" rather than "arbitrary".
 */
export function shouldNotice(
  sessionId: string,
  level: SessionCostLevel,
  seen: Record<string, string>,
): NoticeVerdict {
  const already = RANK[seen[sessionId] as SessionCostLevel] ?? 0;
  if (already >= RANK[level]) return { notice: false, next: seen };

  const next: Record<string, string> = { ...seen, [sessionId]: level };
  const ids = Object.keys(next);
  if (ids.length > MAX_REMEMBERED) {
    for (const id of ids.slice(0, ids.length - MAX_REMEMBERED)) delete next[id];
  }
  return { notice: true, next };
}

/**
 * The large-running-subagent toast's decision (`App.tsx`, beside the cost
 * toast): once per session per CROSSING of `AGENT_LARGE_TOK`.
 *
 * `agent` is the key of the agent over the line right now (its id), or null
 * when none is — below the threshold, finished, or no reading. The record is
 * `{ [sessionId]: agentKey }`:
 *  - null CLEARS the session's entry, which is what re-arms it: the next agent
 *    to cross is a new crossing and is told;
 *  - the same key again is the same crossing on a re-render, and is silent;
 *  - a DIFFERENT key while one was recorded is a second agent crossing, told.
 * Bounded like `shouldNotice`, oldest first. Unchanged reference on a no-op.
 */
export function shouldNoticeAgent(
  sessionId: string,
  agent: string | null,
  seen: Record<string, string>,
): NoticeVerdict {
  if (agent == null) {
    if (!(sessionId in seen)) return { notice: false, next: seen };
    const next = { ...seen };
    delete next[sessionId];
    return { notice: false, next };
  }
  if (seen[sessionId] === agent) return { notice: false, next: seen };
  const next: Record<string, string> = { ...seen, [sessionId]: agent };
  const ids = Object.keys(next);
  if (ids.length > MAX_REMEMBERED) {
    for (const id of ids.slice(0, ids.length - MAX_REMEMBERED)) delete next[id];
  }
  return { notice: true, next };
}
