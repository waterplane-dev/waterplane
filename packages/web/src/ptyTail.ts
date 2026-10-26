/**
 * The attached session's PTY tail: what the reader's live status line reads
 * (`PTY_TAIL`, in memory) and what a cold start with no host paints
 * (`savePtyTail`/`loadPtyTails`, in IndexedDB).
 *
 * Lifted out of `App.tsx` unchanged — the reasoning below is the original's.
 */
import { idbDel, idbGetAll, idbSet } from "./idb.ts";

// Bytes of recent PTY output kept per session for the reader view's live status
// line. A screen's worth is plenty — the CLI's working line is redrawn constantly.
export const PTY_TAIL = 4000;

// ── Offline PTY scrollback ────────────────────────────────────────────────
// A cold start with no host reachable used to paint a black rectangle: the
// buffers live only in this tab's memory, so a reload with the tunnel down had
// literally nothing to write into the xterm and nothing to say about it. The
// attached session's tail is therefore persisted to IndexedDB (localStorage's
// ~5 MB quota belongs to the send outbox, which must never be evicted by our
// own growth) and seeded back on boot.
//
// The stored `seq` is the load-bearing half: handing it back as `resumeSeq` on
// the next `session.attach` lets a LIVE host stitch only the delta onto the
// restored scrollback (see the resumable-replay wire invariant). Without it the
// attach goes out with `resumeSeq: undefined`, the host answers `full: true`,
// and we have paid a whole scrollback re-send to end up where we started.
const PTY_STORE = "pty";
/** Bytes kept per session. A claude TUI repaint is tens of KB, so this is about
 *  one screen's worth of repaints — enough to render, small enough that a dozen
 *  sessions stay under a megabyte. */
export const PTY_SAVE_BYTES = 65536;
/** Save cadence while a session is on screen. `pagehide`/`freeze` are the real
 *  save points (a phone is backgrounded, not closed); the interval is the
 *  backstop for the OS killing the tab without either firing. */
export const PTY_SAVE_MS = 30_000;
/** How often the whole session list's transcripts are topped up for offline
 *  reading. Slow on purpose: a turn ending and the socket reconnecting each
 *  prefetch on their own, so this only has to catch what those missed. */
export const TRANSCRIPT_SWEEP_MS = 5 * 60_000;
/** Newest N sessions kept. An abandoned session's tail would otherwise sit in
 *  IndexedDB forever; falling out just means that session cold-starts empty. */
const PTY_MAX_SESSIONS = 12;

/** `sessionId` is repeated inside the value because `idbGetAll` returns values
 *  only — the prune sweep has to know which row it is about to delete. */
export interface PtyTail { sessionId: string; tail: string; seq: number; savedAt: number; boot?: string; }

/**
 * A PERSISTED resume point is only valid for the host boot that issued it.
 *
 * A `seq` counts bytes since the session's output stream began and carries no
 * host-lifetime marker of its own, while a tmux session outlives the daemon and
 * is re-registered with `seq: 0` on the next boot. A stored offset can therefore
 * land numerically inside the NEW stream's replay window and have the host
 * stitch a delta out of a byte stream that no longer exists — garbled scrollback
 * that reads as a corrupted terminal.
 *
 * So every record carries the `welcome.bootId` it was saved under and hands it
 * back as `session.attach.resumeBoot`; the host replays in FULL whenever that
 * doesn't match its own (main.ts). A record with no boot id (written by an older
 * build) is treated the same way. This is a proof, not a time bound — an idle
 * session resumes cheaply days later, and only an actual restart pays a
 * scrollback. Either way the restored bytes stay on screen, dimmed, until the
 * replay lands: never a black rectangle.
 */

/**
 * Cut a tail at an escape-sequence boundary. Slicing the last N bytes lands
 * mid-`\x1b[…` about as often as not, and xterm renders the surviving fragment
 * as literal garbage across the first painted row. Advancing the cut FORWARD to
 * the next ESC drops at most a partial sequence. Bounded: if the first ESC is
 * far in, the head is ordinary text that was never part of a sequence, so it is
 * cheaper to keep it than to throw away a screen of output.
 */
export function escapeSafeTail(s: string): string {
  const i = s.indexOf("\x1b");
  return i > 0 && i <= 1024 ? s.slice(i) : s;
}

/** Persist one session's tail. Best-effort in every direction: a failed write
 *  just means that session cold-starts with the item-8 empty state instead. */
export async function savePtyTail(sessionId: string, raw: string, seq: number | undefined, boot: string | undefined): Promise<void> {
  if (!raw || seq == null) return; // no seq ⇒ no resume point ⇒ nothing worth storing
  const entry: PtyTail = { sessionId, tail: escapeSafeTail(raw.slice(-PTY_SAVE_BYTES)), seq, savedAt: Date.now(), boot };
  await idbSet(PTY_STORE, sessionId, entry);
  const all = await idbGetAll<PtyTail>(PTY_STORE);
  if (all.length <= PTY_MAX_SESSIONS) return;
  for (const stale of [...all].sort((a, b) => b.savedAt - a.savedAt).slice(PTY_MAX_SESSIONS)) {
    await idbDel(PTY_STORE, stale.sessionId);
  }
}

/** Everything stored, for the one-shot seed at mount. */
export async function loadPtyTails(): Promise<PtyTail[]> {
  return (await idbGetAll<PtyTail>(PTY_STORE)).filter((e) => e && e.sessionId && typeof e.tail === "string");
}
