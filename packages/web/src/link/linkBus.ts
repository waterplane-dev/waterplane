import type { LinkSnapshot, Section } from "./linkTypes";

/**
 * The store's change bus: which sections are dirty, who is listening, and the
 * one `emit`. A LEAF, so the slices that invalidate and emit (status, pulse,
 * sync, log, ops) import it instead of `linkStore`, which reads every one of
 * them to build the snapshot — the two directions used to be one import cycle.
 *
 * The snapshot builder is HANDED in by `linkStore` at its import
 * (`setSnapshotBuilder`). A listener can only be added through `subscribeLink`
 * in that same module, so whenever `emit` has anybody to tell, the builder is
 * already set.
 */

export const dirty = new Set<Section>();

/**
 * Mark a section changed. The next `linkSnapshot()` rebuilds that section and
 * the top-level object; everything else keeps the object it already had.
 *
 * The previous snapshot is deliberately KEPT here rather than cleared — it is
 * what the rebuild copies the untouched sections out of, and dropping it is how
 * a memoization like this quietly stops memoizing anything while still looking
 * correct.
 */
export function invalidate(...s: Section[]): void {
  for (const x of s) dirty.add(x);
}

export interface Listener {
  fn: (s: LinkSnapshot) => void;
  live: boolean;
}
export const listeners = new Set<Listener>();

let build: (() => LinkSnapshot) | null = null;

/** `linkStore`'s one call, at its import: how `emit` gets a snapshot. */
export function setSnapshotBuilder(fn: () => LinkSnapshot): void {
  build = fn;
}

export function emit(): void {
  if (!listeners.size || !build) return;
  const s = build();
  for (const l of listeners) l.fn(s);
}
