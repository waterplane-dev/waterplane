/**
 * The new-session chord's pure half: which presses are "new" (README.md says
 * why each rule is the way it is).
 */
/** The slice of a keydown the decision reads (fakeable in a node test). */
export interface NewKey {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}

/**
 * Ctrl+N, ⌘N or Alt/Option+N, and nothing else held. Alt is matched on `code`
 * because Option+N on a Mac types a dead key, not "n". Shift is never part of
 * it: Ctrl+Shift+N is the browser's private window.
 */
export function isNewSessionPress(e: NewKey): boolean {
  if (e.isComposing || e.shiftKey) return false;
  const isN = e.code === "KeyN" || e.key.toLowerCase() === "n";
  if (!isN) return false;
  if (e.altKey) return !e.ctrlKey && !e.metaKey && e.code === "KeyN";
  return e.ctrlKey !== e.metaKey; // exactly one of them
}

/** The held modifiers the chord answers to (the shortcut card's rows). */
export type NewKeyMod = "ctrl" | "meta" | "alt";

/**
 * Why this modifier's N may never reach the page here, as the sentence the
 * shortcut card prints on its row — or null when it does. A plain browser tab
 * keeps Ctrl+N (Windows/Linux) and ⌘N (everywhere) for a new window; an
 * installed app window and the Android shell get them. The Windows key's N
 * belongs to the system. Alt/Option+N reaches every page.
 */
export function newKeyNote(mod: NewKeyMod, env: { mac: boolean; tab: boolean }): string | null {
  const alt = env.mac ? "⌥N" : "Alt+N";
  if (mod === "alt") return null;
  if (mod === "meta" && !env.mac) return `the system keeps Win+N for itself — ${alt} does the same`;
  if (!env.tab) return null;
  if (mod === "meta") return `this browser tab never receives ⌘N — ${alt} or ⌃N do the same`;
  return env.mac ? null : `this browser tab never receives Ctrl+N — ${alt} does the same`;
}

/** What the chord does here, as the card's verb phrase. */
export function newKeyWhat(repoName: string | null): string {
  return repoName ? `new session in ${repoName}` : "new session — pick a repo";
}
