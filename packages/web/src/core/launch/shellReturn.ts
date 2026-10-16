/**
 * The runtime half of `launch.focusShell` (rules: `shellTab.ts`): which shell tab each caller's key
 * last went to, and the one return the session screen draws (`core/session/ReturnChip.tsx`).
 * Memory-only on purpose — after a reload the reuse falls back to "a running shell in that folder",
 * and a way back to a sheet from a page that no longer exists is not one to offer.
 *
 * Writers: `rememberShell` (`useLaunch`'s `focusShell`, on the person's tap), `noteShellAdopted`
 * (`core/queue/pending.ts`, when the host names a pending open) and `dropReturn` (the chip's ×).
 */
import { createStore } from "../../sdk/store.ts";
import { adoptAll, adoptedShell, type ReturnTo } from "./shellTab.ts";

/** Caller key → the session id (or `pending:<ack>`) its shell tab is. */
export const shellTabs = createStore<Record<string, string>>({});

/** The way back, and the one session screen it is drawn on. */
export const returnTo = createStore<{ sessionId: string; to: ReturnTo } | null>(null);

export function rememberShell(key: string, sessionId: string, back?: ReturnTo): void {
  shellTabs.set((m) => (m[key] === sessionId ? m : { ...m, [key]: sessionId }));
  // A tap with no `back` leaves an existing way back alone: it was registered by a sheet
  // that is still the place the person came from.
  if (back) returnTo.set(() => ({ sessionId, to: back }));
}

export function noteShellAdopted(createAck: string, sessionId: string): void {
  shellTabs.set((m) => adoptAll(m, createAck, sessionId));
  returnTo.set((r) => {
    if (!r) return r;
    const id = adoptedShell(r.sessionId, createAck, sessionId);
    return id === r.sessionId ? r : { ...r, sessionId: id! };
  });
}

export function dropReturn(): void {
  returnTo.set(null);
}
