/**
 * Reconstructed scrollback for an ALTERNATE-screen TUI.
 *
 * The problem this exists for: `claude` draws in the alternate screen buffer, so
 * xterm.js has no scrollback of its own to pan — panning up in the phone's CLI
 * view is translated into mouse-wheel escape sequences that the TUI itself
 * consumes (Terminal.tsx). That is a REMOTE scroll: it needs the socket. With
 * the tunnel down, or slow enough that a flick of wheel events lands seconds
 * later, looking at what was on screen a minute ago is simply impossible — the
 * one thing a phone client is asked to do while the link is bad.
 *
 * Nothing local can recover the TUI's own history, but everything that was ever
 * DISPLAYED passed through this client. So we keep it: after each repaint
 * settles, the visible grid is diffed against the previous one and the lines
 * that scrolled off the top are appended to a per-session archive. Archive plus
 * the live grid is a readable transcript of the screen — scrollable with no host
 * at all, because it is plain text in this tab.
 *
 * This is a RECONSTRUCTION, not a recording, and the UI must say so:
 *  - only what was rendered is here. Output the TUI scrolled past while the app
 *    was closed, or while another session was on screen, never existed locally.
 *  - a view switch (`/usage`, `/resume`) repaints the whole grid with unrelated
 *    content. That is indistinguishable from an enormous scroll, so the outgoing
 *    screen is archived whole; re-entering the conversation later archives it a
 *    second time. Duplicated blocks are the expected cost of never dropping
 *    content, not a bug to chase. A redraw LOWER is not that case: a resize
 *    shifts the grid up and repaints it from the top, and the rows it brings
 *    back are taken off the archive again (`scrollDownCount`).
 *  - styling is dropped. Lines land here as text.
 *
 * Pure and dependency-free, in `shared` rather than `web`, so `e2e-screenlog.mjs`
 * can run the scroll detection over synthetic screens in node.
 */

/** Archived (scrolled-off) lines plus the last grid we saw. */
export interface ScreenLogState {
  /** Oldest first. Capped — the front is dropped, never the newest lines. */
  archived: string[];
  /** The most recent snapshot, still on screen and therefore not archived yet. */
  screen: string[];
}

/** Lines kept per session. ~40-row screens ⇒ dozens of screens of history, and
 *  a few hundred KB at worst for the dozen sessions IndexedDB keeps. */
export const SCREENLOG_MAX_LINES = 4000;

/** Consecutive lines that must match for the new grid's top to be recognised
 *  inside the old one. One line is far too weak (`""`, a lone `⏺`, a repeated
 *  prompt marker all recur); three is enough that a false anchor needs three
 *  identical adjacent lines in the same order. */
const ANCHOR_LINES = 3;

const isBlank = (s: string) => s.trim() === "";

export function newScreenLog(archived: string[] = [], screen: string[] = []): ScreenLogState {
  return { archived, screen };
}

/**
 * How many lines of `prev` scrolled off the top to produce `next`.
 *
 * The match is anchored on the TOP of `next` on purpose. The bottom of a claude
 * screen is the composer, a spinner and a token counter — it changes on every
 * repaint whether anything scrolled or not, so any rule that compares whole
 * grids reports "everything changed" several times a second. The top is settled
 * content: find where `next` begins inside `prev` and the offset IS the scroll.
 *
 * Returns `prev.length` when the anchor is nowhere in `prev` — a full repaint
 * (a view opening, a `/clear`), where treating the whole outgoing screen as
 * scrolled off is exactly right.
 */
export function scrollOffCount(prev: string[], next: string[]): number {
  if (prev.length === 0) return 0;
  // Leading blank rows are not content and their COUNT is unstable between
  // repaints (a composer pads above itself), so the anchor starts at the first
  // real line — never at row 0.
  const j = next.findIndex((l) => !isBlank(l));
  if (j < 0) return 0; // an all-blank grid is a repaint in progress, not a scroll
  const anchor = next.slice(j, j + ANCHOR_LINES);
  for (let i = 0; i < prev.length; i++) {
    let hit = true, compared = 0;
    for (let k = 0; k < anchor.length && i + k < prev.length; k++, compared++) {
      if (prev[i + k] !== anchor[k]) { hit = false; break; }
    }
    // A match that runs off the bottom of `prev` counts: a scroll of nearly a
    // full screen leaves only the first row or two of `next` behind, and
    // refusing those would report the far blunter "everything left".
    if (!hit || compared === 0) continue;
    // Everything above the anchor is gone from the visible grid — including the
    // blank rows a composer pads with, which `absorbScreen` trims back off.
    return i;
  }
  return prev.length;
}

/**
 * Fold one settled snapshot into the log. Pure: returns a new state, and the
 * SAME object when nothing moved, so a caller can skip a re-render or a save.
 */
export function absorbScreen(state: ScreenLogState, next: string[], cap = SCREENLOG_MAX_LINES): ScreenLogState {
  const screen = trimTrailingBlanks(next);
  if (screen.length === 0) return state;             // mid-repaint blank grid
  if (sameLines(state.screen, screen)) return state; // nothing redrew that we can see
  const off = scrollOffCount(state.screen, screen);
  if (off === 0) return { archived: state.archived, screen };
  if (off === state.screen.length) {
    // No anchor for the new top in the old grid — but that is ALSO what a
    // redraw LOWER looks like: a resize (the phone keyboard opening, a
    // rotation) that shifted the screen up and then repainted it from the top
    // brings back rows that were just archived. The old top turning up inside
    // the new grid means nothing left; whatever the archive's tail shares with
    // the rows that reappeared above it is on screen again and comes back off,
    // or the header prints once per keyboard toggle.
    const down = scrollDownCount(state.screen, screen);
    if (down !== null) return { archived: dropRevealed(state.archived, screen.slice(0, down)), screen };
  }
  const archived = state.archived.concat(trimTrailingBlanks(state.screen.slice(0, off)));
  return { archived: archived.length > cap ? archived.slice(archived.length - cap) : archived, screen };
}

/**
 * Where the old grid's top landed inside the new one, when the content moved
 * DOWN rather than scrolled away — null when it is not there. Stricter than
 * `scrollOffCount`: the whole anchor must match, never a partial run off the
 * bottom, because a hit here takes lines back out of the archive.
 */
function scrollDownCount(prev: string[], next: string[]): number | null {
  const j = prev.findIndex((l) => !isBlank(l));
  if (j < 0) return null;
  const anchor = prev.slice(j, j + ANCHOR_LINES);
  for (let i = 1; i + anchor.length <= next.length; i++) {
    if (anchor.every((l, k) => next[i + k] === l)) return i;
  }
  return null;
}

/** The archive minus its tail where that tail is exactly the (non-blank-trimmed)
 *  rows now drawn above the old top — the longest such overlap. The SAME array
 *  when nothing overlaps, so a caller's "did the archive change" still holds. */
function dropRevealed(archived: string[], above: string[]): string[] {
  const shown = trimTrailingBlanks(above);
  for (let k = Math.min(shown.length, archived.length); k > 0; k--) {
    let hit = true;
    for (let m = 0; m < k; m++) {
      if (archived[archived.length - k + m] !== shown[shown.length - k + m]) { hit = false; break; }
    }
    if (hit) return archived.slice(0, archived.length - k);
  }
  return archived;
}

/** Everything readable, oldest first: what scrolled away, then what is on screen. */
export function screenLogLines(state: ScreenLogState): string[] {
  return state.archived.concat(state.screen);
}

function trimTrailingBlanks(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && isBlank(lines[end - 1])) end--;
  return end === lines.length ? lines : lines.slice(0, end);
}

function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
