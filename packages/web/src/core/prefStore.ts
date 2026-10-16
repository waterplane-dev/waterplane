/**
 * The machinery under `prefs.ts`: a table of device preferences, each with its
 * own LOAD (the reader that already existed — `themeChoice()`, `dataSaver()`,
 * `lsGet(LS.x) !== "0"` …) and its own SAVE (the module setter that already
 * existed, or the one `localStorage` write), held as ONE store.
 *
 * Why this exists: App held these as twenty-odd `useState`s, each with a ref
 * mirror for the socket's callbacks and an effect writing it back — three
 * copies of one fact, the ref a render behind the state and the storage an
 * effect behind the ref. Here there is one copy: `set` saves, then commits, and
 * the ref a long-lived callback reads (`ref(k)`) is updated in the same call.
 *
 * Pure of the browser — the table is handed in — so `prefs.test.mjs` runs it
 * under `node --test` over a fake storage.
 */
import { useSyncExternalStore } from "react";
import { createStore } from "../sdk/store.ts";

/** One preference: where it comes from and where it goes. */
export interface PrefDef<T> {
  /** Read the current value from wherever it lives. Must not throw. */
  load(): T;
  /** Write it back — through the key's existing writer, so the sync patch in
   *  `settings.ts` sees every write exactly as it did. */
  save(v: T): void;
  /** Storage keys whose change (another device's copy adopted) re-reads this. */
  keys?: readonly string[];
  /** Equality for a value `load` rebuilds every time (an array). Default `Object.is`. */
  same?(a: T, b: T): boolean;
  /** After a save, publish what `load` reads back rather than the value handed
   *  in — for a writer that NORMALISES (`setDictateLang` stores `whisperLang(code)`),
   *  where the stored form is the truth and the argument is not. */
  reread?: boolean;
}

export type PrefDefs<P> = { [K in keyof P]: PrefDef<P[K]> };

export interface Prefs<P> {
  get<K extends keyof P>(k: K): P[K];
  /** Save through the def, then publish. A value equal to the held one still
   *  SAVES (the caller asked for it written) but re-renders nothing. */
  set<K extends keyof P>(k: K, v: P[K]): void;
  /** Re-read one pref from storage (no save). */
  reload<K extends keyof P>(k: K): void;
  /** A storage key changed under us: re-read every pref that names it.
   *  Returns whether any did. */
  adopt(key: string): boolean;
  /** Re-render on this pref only. */
  use<K extends keyof P>(k: K): P[K];
  /** A ref that always holds the current value — for a callback that runs
   *  outside a render (a socket handler, the queue pump). Stable per key. */
  ref<K extends keyof P>(k: K): { readonly current: P[K] };
  /** Every value, for a test or a snapshot. */
  all(): Readonly<P>;
  subscribe(fn: () => void): () => void;
}

export function createPrefs<P extends object>(defs: PrefDefs<P>): Prefs<P> {
  const names = Object.keys(defs) as (keyof P)[];
  const initial = {} as P;
  for (const k of names) initial[k] = defs[k].load();
  const store = createStore<P>(initial);
  const refs = new Map<keyof P, { current: unknown }>();

  const same = <K extends keyof P>(k: K, a: P[K], b: P[K]) => (defs[k].same ? defs[k].same!(a, b) : Object.is(a, b));

  function commit<K extends keyof P>(k: K, v: P[K]) {
    const prev = store.get();
    if (same(k, prev[k], v)) return;
    const r = refs.get(k);
    if (r) r.current = v;
    store.set({ ...prev, [k]: v });
  }

  return {
    get: (k) => store.get()[k],
    set(k, v) {
      defs[k].save(v);
      commit(k, defs[k].reread ? defs[k].load() : v);
    },
    reload(k) {
      commit(k, defs[k].load());
    },
    adopt(key) {
      let hit = false;
      for (const k of names) {
        if (defs[k].keys?.includes(key)) { commit(k, defs[k].load()); hit = true; }
      }
      return hit;
    },
    use(k) {
      return useSyncExternalStore(store.subscribe, () => store.get()[k]);
    },
    ref<K extends keyof P>(k: K) {
      let r = refs.get(k);
      if (!r) { r = { current: store.get()[k] }; refs.set(k, r); }
      return r as { readonly current: P[K] };
    },
    all: () => store.get(),
    subscribe: store.subscribe,
  };
}

// ── The two spellings of a stored boolean in this app ───────────────────────

/** Default ON: only an explicit `"0"` is off — a device that has never written
 *  the key keeps the default (`autoSend`, `serialSessions`, `confirmQueue`,
 *  `enterSends`). */
export const onUnlessZero = (raw: string | null): boolean => raw !== "0";
/** Default OFF: only an explicit `"1"` is on (`cliMode`). */
export const onIfOne = (raw: string | null): boolean => raw === "1";
/** How both are written. */
export const flagText = (on: boolean): "1" | "0" => (on ? "1" : "0");

/** Equality for a list of strings `load` rebuilds on every read. */
export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
