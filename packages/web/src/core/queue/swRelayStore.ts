/**
 * The PAGE's half of the PWA relay store (`relay`, idb.ts v17) as pure mutations, so node tests
 * run them against the same in-memory store the worker core (`public/swRelay.js`) runs on.
 * The key names are the worker's `WPRelay.KEYS`; `swRelay.test.mjs` pins that they agree.
 *
 * The page writes `plan`, `auth` and `own`; the worker writes `receipts`, `written`, `tries` and
 * reads `released`. A claim is ONE transaction that reads and clears what the worker earned and
 * takes ownership back (`claimedAt`), so a worker write landing a moment later is kept for the
 * next claim rather than lost — and a worker about to write re-checks ownership in its own
 * transaction, so it never starts a send after the claim committed.
 */
import type { RelayClaim, RelayPlan, RelayReceipt } from "@waterplane/shared";

export const RELAY_STORE = "relay";
export const RELAY_KEYS = {
  plan: "plan", own: "own", receipts: "receipts", written: "written", tries: "tries", released: "released", auth: "auth",
} as const;

/** Who owns the queue, as the page last said: the worker reads it (`swOwns`). */
export interface RelayOwnRecord { heartbeatAt?: number; releasedAt?: number; claimedAt?: number }
/** The bearer the worker sends — none when sign-ins are sealed (`deviceToken.ts` `sealedMode`). */
export interface RelayAuthRecord { hostId: string; label: string; sealed: boolean; token?: string }

type Mutation<T> = { put?: Record<string, unknown>; del?: readonly string[]; result: T };

/** The claim: everything the worker earned, cleared, and ownership back to the page. */
export const CLAIM_KEYS = [RELAY_KEYS.own, RELAY_KEYS.receipts, RELAY_KEYS.written] as const;
export function claimMutation(now: number) {
  return (v: Record<string, unknown>): Mutation<RelayClaim> => {
    const receipts = Object.values((v[RELAY_KEYS.receipts] ?? {}) as Record<string, RelayReceipt>);
    const written = Object.entries((v[RELAY_KEYS.written] ?? {}) as Record<string, number>)
      .filter(([, t]) => typeof t === "number")
      .map(([ackId, firstSentAt]) => ({ ackId, firstSentAt }));
    const own: RelayOwnRecord = { ...((v[RELAY_KEYS.own] ?? {}) as RelayOwnRecord), heartbeatAt: now, claimedAt: now };
    return {
      put: { [RELAY_KEYS.own]: own },
      del: [RELAY_KEYS.receipts, RELAY_KEYS.written, RELAY_KEYS.tries, RELAY_KEYS.released],
      result: { receipts, written },
    };
  };
}

/** The page is going away: the worker may own the queue from now. */
export const OWN_KEYS = [RELAY_KEYS.own] as const;
export function releaseMutation(now: number) {
  return (v: Record<string, unknown>): Mutation<true> => ({
    put: { [RELAY_KEYS.own]: { ...((v[RELAY_KEYS.own] ?? {}) as RelayOwnRecord), releasedAt: now } },
    result: true,
  });
}

/** The page is alive (a timer while it runs): the worker keeps its hands off. */
export function heartbeatMutation(now: number) {
  return (v: Record<string, unknown>): Mutation<true> => ({
    put: { [RELAY_KEYS.own]: { ...((v[RELAY_KEYS.own] ?? {}) as RelayOwnRecord), heartbeatAt: now } },
    result: true,
  });
}

/** The latest plan replaces the last, with the bearer beside it. Sealed ⇒ no token is stored. */
export function handMutation(plan: RelayPlan, auth: RelayAuthRecord) {
  return (): Mutation<true> => ({
    put: { [RELAY_KEYS.plan]: plan, [RELAY_KEYS.auth]: auth.sealed ? { hostId: auth.hostId, label: auth.label, sealed: true } : auth },
    result: true,
  });
}

/** Does the plan hold anything the worker could send (or hold for a release)? */
export function planHasItems(plan: RelayPlan | null): boolean {
  return !!plan && plan.lanes.some((l) => l.items.length > 0);
}
