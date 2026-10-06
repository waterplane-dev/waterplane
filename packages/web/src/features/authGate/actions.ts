import { gate } from "./store";

/** The login went through — drop the gate before the reconnect's welcome. */
export function unlocked(): void {
  gate.set(null);
}
