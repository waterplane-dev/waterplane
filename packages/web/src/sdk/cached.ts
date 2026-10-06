/**
 * A host list per repo, seeded from the device cache and saying how old it is.
 *
 * The arrangement `buildCfgs`/`buildCfgsAt` and `captureTargets`/`captureTargetsAt`
 * each spelled out in App as two `Map` states, a snapshot seed and a save-then-
 * stamp on every `*.list` push: **an empty list is a CLAIM** (`localState.ts`),
 * so the reading survives the link, and a cached reading always carries the
 * moment the host last confirmed it. Only the READING is cached — nothing a
 * feature decides goes through here.
 *
 * The load/save pair stays in `localState.ts`, which owns the keys and the
 * per-repo bound; this only holds the result.
 */
import type { Cached } from "../localState.ts";
import { createStore, type Store } from "./store.ts";

export interface CachedLists<T> {
  /** Keyed by worktree path. A missing entry means nobody has said. */
  lists: ReadonlyMap<string, T[]>;
  /** When the host last confirmed each entry — epoch ms. */
  at: ReadonlyMap<string, number>;
}

/** The in-memory view of a `localState` snapshot. */
export function fromSnap<T>(snap: Record<string, Cached<T[]>>): CachedLists<T> {
  const entries = Object.entries(snap);
  return {
    lists: new Map(entries.map(([dir, e]) => [dir, e.v])),
    at: new Map(entries.map(([dir, e]) => [dir, e.at])),
  };
}

/** One repo's fresh list, stamped `at`. A new value, never a mutation. */
export function withList<T>(cur: CachedLists<T>, repoDir: string, list: T[], at: number): CachedLists<T> {
  const lists = new Map(cur.lists);
  const stamps = new Map(cur.at);
  lists.set(repoDir, list);
  stamps.set(repoDir, at);
  return { lists, at: stamps };
}

export interface CachedListStore<T> extends Store<CachedLists<T>> {
  /** The host pushed `list` for `repoDir`: save it to the device, then publish
   *  it with the stamp the save wrote (so the screen and the disk agree). */
  put(repoDir: string, list: T[]): void;
}

export function cachedList<T>(io: {
  load: () => Record<string, Cached<T[]>>;
  save: (repoDir: string, list: T[]) => Record<string, Cached<T[]>>;
}): CachedListStore<T> {
  const s = createStore<CachedLists<T>>(fromSnap(io.load()));
  return {
    ...s,
    put(repoDir, list) {
      const at = io.save(repoDir, list)[repoDir]?.at ?? Date.now();
      s.set((cur) => withList(cur, repoDir, list, at));
    },
  };
}
