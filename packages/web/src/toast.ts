/**
 * The toast, as a module rather than a piece of `App` state.
 *
 * It lived in `App` and was rendered in exactly two of that component's
 * branches — the launcher and the terminal — because `App` returns EARLY once
 * per overlay, one branch per sheet. So every sentence a sheet fired was
 * painted for nobody: a queue row that refused to send ("waiting until the
 * session can take it"), a save that was declined, a mode that was switched.
 * On a phone a control that neither acts nor explains is simply a dead button,
 * which is precisely what got reported.
 *
 * Same fix as `hints.ts` and `netpulse.ts`, and for the same reason: the state
 * lives here, `ToastLayer` is mounted ONCE beside `App` in `main.tsx`, and no
 * screen has to remember to render it. Call sites are unchanged — `showToast`
 * is still one function taking one string.
 *
 * ── Two things a 2.2-second sentence could not do ───────────────────────────
 *
 * Reported: *"toast like notifications that disappear too fast to read and also
 * don't list in the notification list"*. Both halves are the same bug — a
 * sentence this app decided was worth saying was reachable for 2200 ms, once,
 * and then was gone with no record anywhere. A phone is read at arm's length,
 * often while something else is happening on it; a four-line explanation of why
 * a send is being held got the same clock as "copied".
 *
 *  1. **The clock is scaled to the words.** `toastMs()` is pure and tested: a
 *     floor nothing goes under, plus reading time per character, up to a
 *     ceiling — a long sentence is not a longer flash, it is a longer read.
 *     Tapping it dismisses, so the ceiling costs nobody anything.
 *  2. **Every toast is also a row.** It is appended to a bounded, durable LOG
 *     that the notification feed renders under its own heading, labelled as
 *     this phone's own messages rather than the host's alerts — the feed is
 *     where a person goes to ask "what did that say?", and until now it
 *     answered only for the half of the sentences that came over the wire.
 *
 * The log is deliberately NOT the host's notification feed. That feed is
 * host-sourced, per-kind mutable and pushed to the OS; these are local
 * sentences about what this screen just did, most of them uninteresting a
 * minute later. They are kept apart, labelled apart, and cleared apart. They
 * also do not touch the unread badge: a badge that counts "copied" is a badge
 * nobody reads.
 *
 * Durable because the failure mode is a reload — the watchdog's, an update's,
 * or the one a person does when the tunnel looks dead — and the sentence you
 * are trying to re-read is usually the last thing that happened before it.
 */
import type { NotificationItem } from "@waterplane/shared";
import { LS, lsJson, lsSetJson } from "./storage.ts";

/** What even a one-word toast gets — long enough to notice and look at. */
const BASE_MS = 3000;
/** Reading time granted per character, on top of the base. */
const PER_CHAR_MS = 55;
/** Ceiling, because a toast covers the screen it is explaining. Tap dismisses. */
const MAX_MS = 12000;

/** How many messages the log keeps. Bounded on write, oldest dropped. */
const LOG_CAP = 80;
/** Same words again inside this window bump a count instead of adding a row. */
const REPEAT_MS = 60_000;

/**
 * How long these words stay on screen. Pure, so `toast.test.mjs` can hold the
 * floor and the ceiling without a DOM.
 */
export function toastMs(text: string): number {
  // Base PLUS reading time, not the larger of the two: a max() would give the
  // same 3 s to "copied" and to a forty-character sentence, which is the bug.
  return Math.min(MAX_MS, BASE_MS + text.length * PER_CHAR_MS);
}

/** One thing this phone said, and how many times it said it. */
export type ToastEntry = {
  /** When it was LAST said — a repeat moves this, so the list stays ordered. */
  ts: number;
  text: string;
  /** Times said in a row; 1 unless a repeat collapsed into this row. */
  n: number;
  /**
   * The desktop alert this sentence announced, when it announced one.
   *
   * Reported: the rows here "can not be clicked" — and most of them were the
   * desktop's own alerts ("Needs your decision · myrepo", "Outbox: plan.md"),
   * toasted on arrival. The host keeps its feed in memory, so after a host
   * restart these rows were the ONLY copy left, and a copy that names a
   * session or a file without leading to it is a dead end. Kept so the row
   * can do what the desktop row did (`openNotif`).
   */
  notif?: NotificationItem;
};

let current: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<(m: string | null) => void>();

/** Newest first, which is the order the feed renders and the cap trims from. */
let log: ToastEntry[] = readLog();
const logListeners = new Set<(rows: ToastEntry[]) => void>();

function readLog(): ToastEntry[] {
  const rows = lsJson<ToastEntry[]>(LS.toastLog, []);
  if (!Array.isArray(rows)) return [];
  // A hand-edited or older-shaped value is dropped row by row rather than
  // whole: the log has no value worth a crash and no value worth a guess.
  return rows
    .filter((r): r is ToastEntry => !!r && typeof r.text === "string" && Number.isFinite(r.ts))
    .map((r) => ({
      ts: r.ts, text: r.text, n: Number.isFinite(r.n) && r.n > 0 ? r.n : 1,
      ...(r.notif && typeof r.notif.id === "string" && typeof r.notif.title === "string" ? { notif: r.notif } : {}),
    }))
    .slice(0, LOG_CAP);
}

function emit(): void {
  for (const fn of listeners) fn(current);
}

function emitLog(): void {
  for (const fn of logListeners) fn(log);
}

function remember(text: string, at: number, notif?: NotificationItem): void {
  const head = log[0];
  if (head && head.text === text && at - head.ts < REPEAT_MS) {
    // Ten identical "queued" sentences are one fact with a count, not ten rows
    // pushing the sentence you were looking for off the bottom. The newest
    // alert wins the tap: it is the one the count ends on.
    log = [{ ts: at, text, n: head.n + 1, ...((notif ?? head.notif) ? { notif: notif ?? head.notif } : {}) }, ...log.slice(1)];
  } else {
    log = [{ ts: at, text, n: 1, ...(notif ? { notif } : {}) }, ...log].slice(0, LOG_CAP);
  }
  lsSetJson(LS.toastLog, log);
  emitLog();
}

/** Say one sentence, over whatever screen is up. Replaces any toast still on.
 *  `notif`: the desktop alert it announces, so its row in the log can open it. */
export function showToast(m: string, notif?: NotificationItem): void {
  current = m;
  emit();
  remember(m, Date.now(), notif);
  // Restarted, never stacked: two toasts a second apart are one message being
  // corrected, and the second must not be retired by the first one's clock.
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = undefined; current = null; emit(); }, toastMs(m));
}

/** Take it off screen now — the tap on the toast itself. The row stays. */
export function dismissToast(): void {
  if (timer) { clearTimeout(timer); timer = undefined; }
  if (current === null) return;
  current = null;
  emit();
}

/** Subscribe; the current text arrives immediately. Returns the unsubscribe. */
export function onToast(fn: (m: string | null) => void): () => void {
  listeners.add(fn);
  fn(current);
  return () => { listeners.delete(fn); };
}

/** The messages this phone has shown, newest first. */
export function toastLog(): ToastEntry[] {
  return log;
}

/** Subscribe to the log; the current rows arrive immediately. */
export function onToastLog(fn: (rows: ToastEntry[]) => void): () => void {
  logListeners.add(fn);
  fn(log);
  return () => { logListeners.delete(fn); };
}

/**
 * Whether the feed shows this phone's half ABOVE the desktop's. Reported: a
 * long toast "must still show in the notifications list" — it did, but below
 * every desktop alert, so with a handful of those it was off the bottom of the
 * sheet and read as missing. The half holding the newest row goes first; the
 * two halves stay apart (`ToastLog.tsx`), only their order follows recency.
 */
export function phoneHalfFirst(newestHostTs: number | undefined, rows: ToastEntry[]): boolean {
  const head = rows[0];
  if (!head) return false;
  return newestHostTs === undefined || head.ts > newestHostTs;
}

/** Forget them. Only ever the user's own tap — nothing expires on a timer. */
export function clearToastLog(): void {
  log = [];
  lsSetJson(LS.toastLog, log);
  emitLog();
}
