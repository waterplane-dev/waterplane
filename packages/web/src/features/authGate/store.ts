/**
 * Whether the host has gated this connection, and on what.
 *
 * One writer: this feature's message handlers (`authRequired` sets it, the
 * next `welcome` clears it) and `unlocked()` (`actions.ts`), which the gate
 * calls once the password was accepted and the socket is about to reconnect.
 * App reads it through `useAuthGate()` to decide whether the gate takes the
 * whole screen.
 */
import type { PeerKind } from "@waterplane/shared";
import { createStore, useStore } from "../../sdk";

export interface AuthGateState { enabled: boolean; kind: PeerKind }

export const gate = createStore<AuthGateState | null>(null);

/** Non-null while the host has gated this connection — App returns
 *  `<AuthGate/>` instead of everything else. */
export function useAuthGate(): AuthGateState | null {
  return useStore(gate);
}
