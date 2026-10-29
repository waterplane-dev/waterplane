/**
 * A feature's state, outside App: one value, one emit, read with `useStore`.
 *
 * The shape `link.ts` and `toast.ts` already use, made generic so a feature
 * does not hand-roll a third subscribe/emit pair. Host-fed data a feature owns
 * (a sheet's list, a run's output) lives in one of these and **has ONE writer**
 * — the feature's own message handlers or its exported actions, never a
 * component — so "who changed this" always has one answer.
 *
 * `set` with an equal value (`Object.is`) emits nothing. That is what lets a
 * handler return `prev` to keep a chatty push from re-rendering anything, the
 * same rule `build.output` follows in App.
 *
 * **A store whose VALUE is a function must be set through an updater**
 * (`s.set(() => fn)`): a bare `s.set(fn)` is read as an updater and CALLS `fn`.
 */
import { useSyncExternalStore } from "react";

export interface Store<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      const v = typeof next === "function" ? (next as (prev: T) => T)(value) : next;
      if (Object.is(v, value)) return;
      value = v;
      // A copy: a listener that unsubscribes itself mid-emit must not skip the
      // next one along.
      for (const fn of [...subs]) fn();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => { subs.delete(fn); };
    },
  };
}

/** Re-render when the store's value changes. The server snapshot is the same
 *  read: the pin tests server-render sheets, and without one React throws. */
export function useStore<T>(s: Store<T>): T {
  return useSyncExternalStore(s.subscribe, s.get, s.get);
}

/** A sheet's `keep` over the stores its `onLeave` clears (any store: each gets back its own value): their values now, and
 *  the closure that puts them back. Set through an updater, so a function value
 *  is restored rather than called. */
export function keepStores(...stores: Store<any>[]): () => () => void {
  return () => {
    const vals = stores.map((s) => s.get());
    return () => stores.forEach((s, i) => s.set(() => vals[i]));
  };
}
