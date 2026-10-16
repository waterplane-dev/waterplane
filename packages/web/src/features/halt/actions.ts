/**
 * Every writer of the halt store and every frame this feature sends. Both are
 * LIVE-ONLY, never queued: a halt replayed an hour later is a halt nobody asked
 * for any more, and a lift replayed after a second halt undoes it.
 */
import type { HaltState } from "@waterplane/shared";
import { core } from "../../sdk";
import { askConfirm } from "../../Confirm";
import { HALT_CONFIRM_LINES } from "./logic";
import { haltStore } from "./store";

export function onHaltState(halt: HaltState): void {
  haltStore.set(() => halt);
}

/** Ask once, then halt. */
export async function askHalt(): Promise<void> {
  const ok = await askConfirm({
    title: "Halt all AI on this desktop?",
    lines: [...HALT_CONFIRM_LINES],
    confirmLabel: "Halt everything",
    tone: "warn",
  });
  if (!ok) return;
  core().conn.liveSend({ t: "host.halt", on: true }, "halting — every agent session is being stopped",
    "not halted: no link to the desktop right now");
}

/** Lift the latch. Nothing that was stopped comes back by itself; only automatic work may start again. */
export function liftHalt(): void {
  core().conn.liveSend({ t: "host.halt", on: false }, "halt lifted — automatic work may start again; stopped sessions stay closed",
    "still halted: no link to the desktop right now");
}
