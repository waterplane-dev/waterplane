/**
 * The one timer registry of a session's recovery lanes.
 *
 * Four lanes each used to keep a raw `setTimeout` on the Session record (the usage-limit
 * wall, the net retry and its log re-read, the sign-in wait, the resume/resurrect), and a
 * cancel one of them missed could type `continue` twice. Here there is exactly one pending
 * timer per lane per session BY CONSTRUCTION: `arm` cancels the lane's previous timer first,
 * `cancelAll` is the teardown's one call. Every timer goes through the `Clock`
 * (`waitclock.ts`), so a unit test drives time by hand (`test/lib/fakeclock.mjs`).
 *
 * Keyed by the Session object in a WeakMap: nothing is added to the record, and a session
 * that is dropped takes its entries with it.
 */
import { realClock, type Clock } from "../waitclock.js";

export type Lane = "wall" | "net" | "netRecheck" | "signin" | "resume";
export const LANES: readonly Lane[] = ["wall", "net", "netRecheck", "signin", "resume"];

interface Entry { cancel: () => void }
const registry = new WeakMap<object, Map<Lane, Entry>>();

/** The clock a slice reads: the core's, else the real one (a fake core in a test names none, or a Proxy answers every key). */
export function clockOf(core: { clock?: Clock }): Clock { return typeof core.clock?.after === "function" ? core.clock : realClock; }

/** Run `fn` in `ms` on `lane`; a timer already pending on the lane is cancelled first. `fn` runs with the lane free. */
export function arm(s: object, lane: Lane, ms: number, fn: () => void, clock: Clock = realClock): void {
  cancel(s, lane);
  let m = registry.get(s);
  if (!m) { m = new Map(); registry.set(s, m); }
  const lanes = m;
  const entry: Entry = { cancel: () => {} };
  entry.cancel = clock.after(ms, () => {
    if (lanes.get(lane) !== entry) return; // cancelled or re-armed
    lanes.delete(lane);
    fn();
  });
  lanes.set(lane, entry);
}

export function cancel(s: object, lane: Lane): void {
  const m = registry.get(s);
  const e = m?.get(lane);
  if (!e) return;
  m!.delete(lane);
  e.cancel();
}

/** Session exit, kill, remove: every lane's timer goes. */
export function cancelAll(s: object): void { for (const l of LANES) cancel(s, l); }

export function pending(s: object, lane: Lane): boolean { return !!registry.get(s)?.has(lane); }
