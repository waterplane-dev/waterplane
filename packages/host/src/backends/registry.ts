/**
 * The live list of backends this host can spawn — core's two, plus whatever a
 * plugin has registered while it is switched on (`docs/analysis/backends-design.md`
 * §1.2, §3).
 *
 * **Refusals are sentences.** A duplicate id, an id that is not a plain word, or
 * `facts` that name a reader this host does not have all throw at
 * REGISTRATION, listing what would have worked — so a bad plugin is a
 * listed-broken plugin, never a backend that half-exists. Registration never
 * replaces: two backends answering to one id would mean a launch might spawn
 * either, which is the substitution `resolveBackend` exists to forbid.
 *
 * **Core is not removable.** `registerCore` is the boot path (`index.ts` seeds
 * claude and opencode); `unregisterBackend` refuses a core id in words and
 * answers whether it removed anything otherwise. A change fires every
 * `onBackendsChanged` listener, which is how the `backends` frame is re-broadcast
 * without this module knowing the socket layer.
 *
 * `BACKENDS` is the one array, mutated in place, so a reader holding the
 * reference sees the current list; callers get it as `readonly`.
 */
import type { BackendDescriptor } from "./types.js";
import { contributedReaders } from "./readers.js";
import { launchModesProblems, spendUnitProblems } from "@waterplane/shared";
import { factProblems } from "./derive.js";

const LIST: BackendDescriptor[] = [];
const CORE = new Set<string>();
const LISTENERS = new Set<() => void>();

/** Every backend this host can spawn right now, in the order a person is offered them. */
export const BACKENDS: readonly BackendDescriptor[] = LIST;

function changed(): void {
  for (const cb of [...LISTENERS]) {
    try { cb(); } catch { /* a listener must not break a registration */ }
  }
}

/** The ids that would work, as the sentence tails use them. */
export function liveIds(): string {
  return LIST.map((b) => b.id).join(", ");
}

function refusal(d: BackendDescriptor): string | null {
  const id = (d as { id?: unknown }).id;
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(id)) {
    return `a backend id must be a short lowercase word (letters, digits, dashes); got ${JSON.stringify(id)}`;
  }
  if (LIST.some((b) => b.id === id)) {
    return `a backend called "${id}" is already registered; the live ones are: ${liveIds()}`;
  }
  const capsBad = launchModesProblems(d.caps?.permissionModes ?? [], (d.caps as { launchModes?: unknown } | undefined)?.launchModes);
  if (capsBad.length) return `backend "${id}": ${capsBad.join("; ")}`;
  const unitBad = spendUnitProblems((d.caps as { spendUnit?: unknown } | undefined)?.spendUnit);
  if (unitBad.length) return `backend "${id}": ${unitBad.join("; ")}`;
  const bad = factProblems((d as { facts?: unknown }).facts, contributedReaders());
  if (bad.length) return `backend "${id}": ${bad.join("; ")}`;
  return null;
}

/** Boot-time registration of a built-in backend. Throws the same sentences; core cannot be unregistered. */
export function registerCore(d: BackendDescriptor): void {
  const why = refusal(d);
  if (why) throw new Error(why);
  LIST.push(d);
  CORE.add(d.id);
  changed();
}

/** Register a plugin's backend. Throws a sentence on refusal; nothing is half-added. */
export function registerBackend(d: BackendDescriptor): void {
  const why = refusal(d);
  if (why) throw new Error(why);
  LIST.push(d);
  changed();
}

/**
 * Remove a registered backend. True when one was removed, false when no such
 * plugin backend was registered; a CORE id throws, naming what it is.
 */
export function unregisterBackend(id: string): boolean {
  if (CORE.has(id)) throw new Error(`"${id}" is built into this host and cannot be unregistered`);
  const at = LIST.findIndex((b) => b.id === id);
  if (at < 0) return false;
  LIST.splice(at, 1);
  changed();
  return true;
}

/** Subscribe to the list changing; returns the unsubscribe. */
export function onBackendsChanged(cb: () => void): () => void {
  LISTENERS.add(cb);
  return () => { LISTENERS.delete(cb); };
}
