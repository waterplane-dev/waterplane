/**
 * The static web demo's own storage (demo-mode-plan.md §4).
 *
 * A browser has no host list to park keys in, so a demo page there would read
 * and write the SAME localStorage the real app uses — on a real host's origin
 * that is somebody's drafts, queue and settings, and the demo would both show
 * them and leave its own rubbish behind. So while the demo is asked for
 * (`?demo=` or the device flag) and this is not the Android shell (whose demo
 * is a `SavedHost`, `hosts.ts`), `window.localStorage` is swapped for a view of
 * the same store under `DEMO_WORLD_PREFIX`. One swap at boot rather than a
 * prefix per call site: sixty modules read storage directly, and a rule that
 * holds only where someone remembered to call a helper is the kind this app
 * keeps being bitten by (`hostUrl.ts` argues the same for `fetch`).
 *
 * The one key that stays on the real name is `LS.demo` itself: "am I in the
 * demo" is about the device, and leaving has to be able to clear it.
 */
import { DEMO_WORLD_PREFIX, LS } from "../storage.ts";
import { demoScenarioId } from "./mode.ts";

/** A `Storage` over `real` whose keys all live under `prefix`, `exempt` aside. Pure. */
export function prefixedStorage(real: Storage, prefix: string, exempt: ReadonlySet<string>): Storage {
  const name = (k: string): string => (exempt.has(k) ? k : prefix + k);
  const mine = (): string[] => {
    const out: string[] = [];
    for (let i = 0; i < real.length; i++) {
      const k = real.key(i);
      if (k !== null && k.startsWith(prefix)) out.push(k.slice(prefix.length));
    }
    return out;
  };
  return {
    get length() { return mine().length; },
    key: (i: number) => mine()[i] ?? null,
    getItem: (k: string) => real.getItem(name(String(k))),
    setItem: (k: string, v: string) => real.setItem(name(String(k)), String(v)),
    removeItem: (k: string) => real.removeItem(name(String(k))),
    clear: () => { for (const k of mine()) real.removeItem(prefix + k); },
  } as Storage;
}

/** Put the demo's storage in place, when this page is the static web demo. */
export function installDemoWorld(isShell: boolean): boolean {
  if (isShell || typeof window === "undefined" || !demoScenarioId()) return false;
  try {
    const real = window.localStorage;
    const facade = prefixedStorage(real, DEMO_WORLD_PREFIX, new Set([LS.demo]));
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => facade });
    return true;
  } catch {
    return false; // storage blocked: nothing to read or write anyway
  }
}
