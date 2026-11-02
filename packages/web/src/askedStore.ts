/**
 * A value asked of something slow (the Android shell, over the bridge) and held as ONE reading for
 * every reader: `refresh` asks again, and concurrent refreshes share one call — the launcher's count
 * and the sheet mounted at once must not ask twice nor see two answers. Pure (no DOM, no bridge):
 * the caller binds `ask` and decides when to refresh (`useInstallCaps.ts`: mount, resume, after the
 * Settings screen). `askedStore.test.mjs` runs it.
 *
 * A rejected ask keeps the last value and clears the in-flight call, so the next refresh asks again;
 * it never surfaces as an unhandled rejection from a `void refresh()` call site.
 */
export interface AskedStore<T> {
  subscribe(fn: () => void): () => void;
  get(): T;
  /** Ask again (one call however many ask at once); every subscriber hears the answer. */
  refresh(): Promise<void>;
  /** A local change that needs no ask (a switch the reader just flipped). */
  set(next: T): void;
}

export function createAskedStore<T>(ask: () => Promise<T>, initial: T): AskedStore<T> {
  let value = initial;
  const subs = new Set<() => void>();
  let inflight: Promise<void> | null = null;
  const put = (next: T): void => {
    value = next;
    // A copy: a listener that unsubscribes (itself or another) mid-emit never skips the rest.
    for (const fn of [...subs]) fn();
  };
  return {
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    get: () => value,
    refresh() {
      if (inflight) return inflight;
      inflight = ask()
        .then(put)
        .catch(() => { /* keep the last reading; the next refresh asks again */ })
        .finally(() => { inflight = null; });
      return inflight;
    },
    set: put,
  };
}
