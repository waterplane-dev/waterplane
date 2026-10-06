/**
 * The two decisions `settings.ts` makes about a value it is about to PUSH.
 *
 * Both of them are ways to overwrite the shared copy with something wrong, both
 * fail silently, and neither is visible at the call site — which is why they
 * are stated here, where `node --test` can run them without a browser
 * (`settings.ts` itself patches `localStorage` and cannot be imported without
 * one). The runtime half stays there; the rules are these two functions.
 *
 * The subject in both cases is a key with an `AdoptGuard` — in practice the
 * pad, the one synced key whose value is a LIST rather than a preference. For a
 * preference, last-write-wins is exactly right. For a list, "wins" means the
 * other device's notes stop existing, so anything that pushes an un-merged copy
 * of a list under a fresh timestamp is a data loss with a receipt saying
 * `synced`.
 */

/** An `AdoptGuard`, as this module sees it: two copies in, the merge out. */
export type MergeFn = (incoming: string, current: string | null) => string | void;

/**
 * Has an adoption produced something the host has not got — and did it LAND?
 *
 * `applyLocally` merges, writes, and then pushes the merge back so the exchange
 * converges. But the write can fail: `localStorage.setItem` throws on quota,
 * and this device then still holds the OLD value. The push that followed read
 * the store back (`localValue`), found that old value, and sent it with a stamp
 * strictly newer than the host's — so a failed write turned into the host
 * adopting a copy that predates what it already had. Not a loss against a peer
 * that merges on its way back in, but a real one against the host, and invisible
 * from every screen.
 *
 * So the flag is the WRITE's, taken inside the `try` and nowhere else: no write,
 * no push, and the two sides reconcile on the next `settings.all` instead.
 */
export function repushAfterAdopt(wrote: boolean, final: string, incoming: string): boolean {
  return wrote && final !== incoming;
}

/**
 * What a device that is AHEAD of the host should actually push.
 *
 * `mergeSettingsDoc` compares stamps per key, and when ours is newer it pushes.
 * For a list that is only half the story: a device that wrote its pad offline
 * at t1, while another device pushed its own at t0 < t1, is "ahead" and pushes
 * a copy that has never seen the other one's notes. Those notes leave the host
 * until that device reconnects and unions them back — a detour rather than a
 * loss, since the tombstones make the merge convergent either way, but the
 * guard that would have avoided it is one call away and already registered.
 *
 * So: merge first where a guard exists, push the union. Returns the merged
 * value, or `null` for "nothing to merge in — push what you hold", which is
 * also the answer when the guard threw (a merge is best effort; it may never
 * be able to stop the push) or when the host has no copy at all.
 */
export function aheadValue(local: string, remote: string | undefined, merge: MergeFn | undefined): string | null {
  if (remote === undefined || !merge) return null;
  let merged: string | void = undefined;
  try { merged = merge(remote, local); } catch { return null; }
  if (typeof merged !== "string" || merged === local) return null;
  return merged;
}
