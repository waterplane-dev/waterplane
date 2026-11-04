/**
 * Whether the card is up, and whether a cold start is still waiting on the sealed sign-ins. One
 * writer each: `actions.ts`/`tokenSealActions.ts` for `locked`, `tokenSealActions.ts` for `sealGate`.
 */
import { createStore, useStore } from "../../sdk";
import { SEAL_GATE_OPEN, type SealGate } from "./logic";

export const locked = createStore<boolean>(false);
export const sealGate = createStore<SealGate>(SEAL_GATE_OPEN);

/** True while the lock card covers the app. */
export function useAppLock(): boolean {
  return useStore(locked);
}

/** The cold-start gate, for the card. */
export function useSealGate(): SealGate {
  return useStore(sealGate);
}

/** True until the sign-ins opened or the person went on without them: `App`, which dials the
 *  socket on its first render, is not mounted before that. */
export function useSealWaiting(): boolean {
  return useStore(sealGate).waiting;
}
