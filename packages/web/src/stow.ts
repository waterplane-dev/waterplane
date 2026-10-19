/**
 * Folding a strip away without losing it — the store behind `Stowable.tsx`.
 *
 * The session screen grows strips above the prompt bar (a shell's link card,
 * the sign-in card, the next prompt) and each one takes its height FROM the
 * terminal. Once read, most of them are only in the way, but they are not
 * finished — the link is still the link, the code still the code — so closing
 * one must be a FOLD, never a delete: it shrinks to a chip in the session's
 * status line and a tap there brings it back.
 *
 * Two keys per fold. The SLOT says which strip ("shell-links"); the CONTENT key
 * says which state of it was folded (the link and code it showed). A fold holds
 * only while that state does: a new link, a new code or the CLI starting to wait
 * for one is a new thing to read, and it comes back up by itself rather than
 * waiting behind a chip nobody is looking at. Once news has unfolded a strip
 * its old mark is DROPPED (`Stowable`): the strip's own height changes what a
 * shell shows, so the old state returning must not fold it again — that was a
 * card flipping open and shut forever (`npm login`, 2026-10-19).
 *
 * Marks persist per device (`LS.stowed`) so a reload — every OTA update is one —
 * does not undo a fold; bounded by age and count on every write.
 */
import type { LucideIcon } from "lucide-react";
import { LS, lsBool, lsJson, lsSetBool, lsSetJson } from "./storage.ts";
import { showToast } from "./toast.ts";

export const STOW_KEEP_MS = 7 * 24 * 3600_000;
export const STOW_MAX = 60;

export const stowMark = (slot: string, key: string): string => `${slot}|${key}`;

/**
 * A content key is a set of FACTS, one per line (a link, a code, "await"). A
 * fold holds while every fact on screen was there when it was folded: a fact
 * gone since is not news, a fact the fold never saw is. Order never counts —
 * the host reorders links when it re-reads them.
 */
const factsOf = (key: string): string[] => key.split("\n").filter(Boolean);

/** Two content keys with a fact in common — the same strip, moved on. */
export function sharesFact(a: string, b: string): boolean {
  const had = new Set(factsOf(a));
  return factsOf(b).some((f) => had.has(f));
}

/** The stored key whose fold covers `key` under `slot`, or null when nothing does. */
export function coveringKey(slot: string, key: string): string | null {
  const want = factsOf(key);
  const pre = `${slot}|`;
  for (const mark of Object.keys(load())) {
    if (!mark.startsWith(pre)) continue;
    const k = mark.slice(pre.length);
    if (!want.length) { if (k === key) return k; continue; }
    const had = new Set(factsOf(k));
    if (want.every((f) => had.has(f))) return k;
  }
  return null;
}

/** Drop marks older than `keepMs`, then keep the newest `max`. Pure. */
export function pruneStowed(
  marks: Readonly<Record<string, number>>, now: number, keepMs = STOW_KEEP_MS, max = STOW_MAX,
): Record<string, number> {
  const live = Object.entries(marks)
    .filter(([, at]) => typeof at === "number" && now - at < keepMs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max);
  return Object.fromEntries(live);
}

/** One folded strip, as its chip draws it. */
export interface TrayEntry {
  slot: string;
  label: string;
  /** A short live fact the chip keeps showing while folded (a code, a count). */
  detail?: string;
  icon: LucideIcon;
  unfold(): void;
}

let marks: Record<string, number> | null = null;
const tray = new Map<symbol, TrayEntry>();
let trayView: TrayEntry[] = [];
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version++;
  trayView = [...tray.values()];
  for (const fn of listeners) fn();
}

function load(): Record<string, number> {
  if (!marks) marks = pruneStowed(lsJson<Record<string, number>>(LS.stowed, {}), Date.now());
  return marks;
}

export function subscribeStow(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
export const stowVersion = (): number => version;
export const trayEntries = (): TrayEntry[] => trayView;

export function isStowed(slot: string, key: string): boolean {
  return coveringKey(slot, key) != null;
}

/** First fold on this device says where the strip went; later ones are a receipt by sight. */
export const STOW_TOLD = "folded into the line under the session's title — tap its chip there to open it again";

export function stow(slot: string, key: string): void {
  marks = pruneStowed({ ...load(), [stowMark(slot, key)]: Date.now() }, Date.now());
  lsSetJson(LS.stowed, marks);
  if (!lsBool(LS.stowTold)) { lsSetBool(LS.stowTold, true); showToast(STOW_TOLD); }
  emit();
}

export function unstow(slot: string, key: string): void {
  const m = { ...load() };
  delete m[stowMark(slot, key)];
  marks = m;
  lsSetJson(LS.stowed, marks);
  emit();
}

/** A folded strip puts its chip up; the returned function takes it down. */
export function trayAdd(e: TrayEntry): () => void {
  const id = Symbol(e.slot);
  tray.set(id, e);
  emit();
  return () => { tray.delete(id); emit(); };
}
