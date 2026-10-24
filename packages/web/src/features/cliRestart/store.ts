/**
 * Sessions armed to restart once idle: `<session id>` → the installed version
 * the tap was for. ONE writer: `actions.ts`. In memory on purpose — a reload
 * forgets the arm and the banner offers both buttons again, which is the safe
 * direction for something that kills a process.
 */
import { createStore, useStore } from "../../sdk";

export const armedStore = createStore<Readonly<Record<string, string>>>({});

export function useArmedRestart(id: string): string | undefined {
  return useStore(armedStore)[id];
}
