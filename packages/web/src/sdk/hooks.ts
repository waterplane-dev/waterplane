/**
 * The hooks a feature's components use. Deliberately few: anything App-wide
 * comes through `useCore()`, anything the feature owns through `useStore`.
 */
import { useRef, useState } from "react";
import { core } from "../core/api.ts";
import { outboxStore } from "../core/queue/store.ts";
import { useStore } from "./store.ts";
import type { OutboxEntry } from "../outbox.ts";
import type { CoreApi } from "./types.ts";

/** The core as of this render. The same object `core()` returns — a hook only
 *  so a component's reads read like the rest of its hooks. */
export function useCore(): CoreApi {
  return core();
}

/**
 * The send queue, for a component that lists or counts it — the queue core's
 * own store (`core/queue/store.ts`), which `writeOutbox` alone writes. A
 * component reading this re-renders on every queue write, wherever it is.
 */
export function useQueueEntries(): readonly OutboxEntry[] {
  return useStore(outboxStore);
}

/**
 * A ref that always holds this render's value — for a long-lived callback (a
 * socket handler, a timer) that must read current state without re-subscribing.
 * App's `overlayRef.current = overlay` pairs, as one line.
 */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** A copy of `m` with `k` set — never a mutation, so React sees a new value. */
export function mapWith<K, V>(m: ReadonlyMap<K, V>, k: K, v: V): Map<K, V> {
  const n = new Map(m);
  n.set(k, v);
  return n;
}

/** A copy of `m` without `k`; `m` itself when `k` was absent (no re-render). */
export function mapWithout<K, V>(m: ReadonlyMap<K, V>, k: K): ReadonlyMap<K, V> {
  if (!m.has(k)) return m;
  const n = new Map(m);
  n.delete(k);
  return n;
}

/**
 * A per-repo `Map` in component state with its two writers, which App spells
 * as `setX((prev) => { const n = new Map(prev); n.set(k, v); return n; })` at
 * every site. Functional, so two pushes in one batch both land.
 */
export function useRepoMap<V>(init: () => ReadonlyMap<string, V> = () => new Map()) {
  const [map, setMap] = useState<ReadonlyMap<string, V>>(init);
  const put = (k: string, v: V) => setMap((prev) => mapWith(prev, k, v));
  const drop = (k: string) => setMap((prev) => mapWithout(prev, k));
  return [map, put, drop] as const;
}
