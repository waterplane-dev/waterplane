/**
 * The host's halt latch, as `halt.state` says it. ONE writer: `onHaltState` in
 * `actions.ts`. Starts OFF until the host has said — a phone that has not
 * heard yet must not draw a banner claiming everything is stopped.
 */
import { HALT_OFF, type HaltState } from "@waterplane/shared";
import { createStore, useStore } from "../../sdk";

export const haltStore = createStore<HaltState>({ ...HALT_OFF });

export function useHalt(): HaltState {
  return useStore(haltStore);
}
