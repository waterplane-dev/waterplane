/**
 * THE KEYBOARD SHORTCUTS, DECLARED ONCE — what the hold card (`ShortcutCard.tsx`)
 * lists when a modifier is held alone.
 *
 * Each chord is one entry: which held modifier(s) it answers to, the key's
 * label, what it does as a short verb phrase, and `when()` — is it live RIGHT
 * NOW. The handler that runs the chord reads the SAME predicate (the new-session
 * chord's `newKeyFree`, the dialog key's `primaryButton`, the compose box's
 * focus), so the card can never list a chord that does nothing.
 *
 * Owners register at boot — a feature through its manifest's `boot`, core and
 * the top-level dialogs from their own installers — because features may not
 * import each other, and this is the top-level slot between them (the
 * `peersSlot.ts` shape).
 *
 * The labels are the platform's: ⌘/⌥ on a Mac, Ctrl/Alt elsewhere. Pure apart
 * from the store, and node-tested (`shortcuts.test.mjs`).
 */
import { createStore } from "./sdk/store.ts";

/** A modifier held ALONE. `meta` is ⌘ on a Mac (the Windows key elsewhere). */
export type HeldMod = "ctrl" | "meta" | "alt";

/** What the labels and the "does this key even reach the page?" notes read. */
export interface KeyEnv {
  mac: boolean;
  /** A plain browser tab — not an installed app window, not the Android shell.
   *  The browser keeps some chords for itself there and the page never sees them. */
  tab: boolean;
}

export interface Shortcut {
  /** Stable, for unregistering and React keys. */
  id: string;
  /** The held modifiers this chord answers to. */
  mods: readonly HeldMod[];
  /** The key as printed on it ("N"), or a platform word via `keyLabel`. */
  key: string;
  /** What it does now, as a short verb phrase ("send", "new session in api"). */
  what: () => string;
  /** Is it live right now? The handler reads the same predicate. */
  when: () => boolean;
  /** A sentence when the key cannot reach the page here (worded, never greyed). */
  note?: (mod: HeldMod, env: KeyEnv) => string | null;
}

/** One line of the card. */
export interface ShortcutRow {
  id: string;
  key: string;
  what: string;
  note: string | null;
}

const table = createStore<readonly Shortcut[]>([]);

/** Add an entry; returns the removal (a manifest `boot` hands it back). A
 *  second entry with the same id replaces the first. */
export function registerShortcut(s: Shortcut): () => void {
  table.set((list) => [...list.filter((x) => x.id !== s.id), s]);
  return () => table.set((list) => list.filter((x) => x !== s));
}

export const registeredShortcuts = (): readonly Shortcut[] => table.get();

/** `Return` on a Mac, `Enter` elsewhere — the word printed on the key. */
export function keyLabel(key: string, env: Pick<KeyEnv, "mac">): string {
  if (key === "Enter") return env.mac ? "Return" : "Enter";
  return key.length === 1 ? key.toUpperCase() : key;
}

/** The held modifier as the keyboard here prints it. */
export function modLabel(mod: HeldMod, env: Pick<KeyEnv, "mac">): string {
  if (mod === "meta") return env.mac ? "⌘" : "Win";
  if (mod === "alt") return env.mac ? "⌥" : "Alt";
  return env.mac ? "⌃" : "Ctrl";
}

/**
 * The card's rows for one held modifier: only entries answering to it whose
 * `when()` holds now. A predicate that throws reads as "not now" — the card is
 * an aid and must never take the keyboard down with it.
 */
export function shortcutsFor(list: readonly Shortcut[], mod: HeldMod, env: KeyEnv): ShortcutRow[] {
  const rows: ShortcutRow[] = [];
  for (const s of list) {
    if (!s.mods.includes(mod)) continue;
    let live = false;
    let what = "";
    try { live = s.when(); if (live) what = s.what(); } catch { live = false; }
    if (!live) continue;
    rows.push({ id: s.id, key: keyLabel(s.key, env), what, note: s.note?.(mod, env) ?? null });
  }
  return rows;
}

/** Is this a Mac (or an iPad with a keyboard, which prints ⌘ too)? */
export function detectMac(nav: { platform?: string; userAgentData?: { platform?: string } } | undefined): boolean {
  const p = nav?.userAgentData?.platform || nav?.platform || "";
  return /mac|iphone|ipad|ipod/i.test(p);
}
