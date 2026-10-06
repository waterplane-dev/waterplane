/** Kept out of `hooks.ts`: `link.ts` has extensionless imports `sdk.test.mjs` (node) cannot resolve. */
import { useLink, type LinkStatus } from "../link.ts";

/** The socket's status, REACTIVE (`link.ts`'s one store) — for an effect that must re-run when the link
 *  comes back (`core().conn.status` is a live read, not a subscription). */
export function useConnStatus(): LinkStatus {
  return useLink((s) => s.status);
}
