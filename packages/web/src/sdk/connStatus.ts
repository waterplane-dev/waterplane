/** Kept out of `hooks.ts`: `link.ts` has extensionless imports `sdk.test.mjs` (node) cannot resolve. */
import { subscribeLink, useLink, type LinkStatus } from "../link.ts";

/** The socket's status, REACTIVE (`link.ts`'s one store) — for an effect that must re-run when the link
 *  comes back (`core().conn.status` is a live read, not a subscription). */
export function useConnStatus(): LinkStatus {
  return useLink((s) => s.status);
}

/** The same status outside React, for a `boot`: called with the current status at once, then only on a
 *  CHANGE of it (the link store emits on every pulse and byte; those are not news here). Returns the
 *  unsubscribe. */
export function watchConnStatus(fn: (status: LinkStatus) => void): () => void {
  let last: LinkStatus | undefined;
  return subscribeLink((s) => {
    if (s.status === last) return;
    last = s.status;
    fn(s.status);
  });
}
