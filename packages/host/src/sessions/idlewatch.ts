/**
 * When output on the PTY ends `idle` — split out of `sessions/turn.ts` so that
 * file stays under its slice cap. The facade calls `noteOutput`; `turn.ts`
 * reaches `clearIdle` through `core` (a slice never imports a slice).
 */
import { workingLine } from "@waterplane/shared";
import { derive } from "../backends/derive.js";
import { stripAnsi } from "../prompt.js";
import type { Session, SessionCore } from "./core.js";
import { IDLE_WATCH_MS, STOP_VERIFY_BYTES } from "./knobs.js";

/**
 * Output landed on the PTY. Does it mean the session is no longer idle?
 *
 * **Not by itself.** An idle claude prompt is not a silent one: the cursor
 * blinks, a resize repaints the whole frame, a status line ticks, the footer
 * redraws. Clearing `idle` on every byte (what the data handler used to do)
 * meant the phone's pill read "coding" over an idle prompt for four seconds
 * after each of those — and for ever, on a status line that ticks faster than
 * `IDLE_PING_MS`. And `idleSince` restarted, and an unwatched session was
 * re-marked `newActivity` after every redraw.
 *
 * What ends idle instead is evidence of work, and every one of them already
 * existed: a turn starting (`setTurn(true)` — a hook's `UserPromptSubmit`, our
 * own Return on an unhooked session, the turn watch reading a spinner), or,
 * read here, the CLI's own working line (`shared/working.ts`, the same matcher
 * `checkTurnWatch` and the phone's reader use) on the rendered grid after this
 * output. Nothing new is guessed: when the line is not there, the redraw was a
 * redraw and `idle` stays as it was.
 *
 * Only for claude's TUI — the one `workingLine` was measured on (the same gate
 * `checkCliSuggestion` uses). Another backend's screen has no reader for
 * "working", so it keeps the old rule: any output ends idle. Degrading to the
 * old signal, never to a pill stuck on "done" over real work.
 *
 * `seqAt` is the output offset BEFORE this chunk, so the fallback (no recorder)
 * reads only fresh bytes.
 */
export function noteOutput(core: SessionCore, s: Session, seqAt: number): void {
  if (!s.info.idle) return;
  if (derive(s.backend).screen("dialogs") !== "claude-numbered") { clearIdle(core, s); return; }
  if (s.idleWatchTimer) return; // one pending read; it covers everything printed until it runs
  s.idleWatchSeq = seqAt;
  s.idleWatchTimer = setTimeout(() => {
    s.idleWatchTimer = null;
    checkIdleWatch(core, s, s.idleWatchSeq ?? seqAt);
  }, IDLE_WATCH_MS);
  s.idleWatchTimer.unref?.();
}

/** The read `noteOutput` armed: the working line on the grid ends idle; a
 *  redraw without one leaves it set. Exported for the test. */
export function checkIdleWatch(core: SessionCore, s: Session, seqAt: number): void {
  if (!s.info.running || !s.info.idle) return;
  const fresh = s.seq - seqAt;
  if (!(fresh > 0)) return;
  const grid = s.screenLog?.gridText() ?? "";
  const tail = grid || stripAnsi(s.scrollback.slice(-Math.min(fresh, STOP_VERIFY_BYTES)));
  if (workingLine(tail)) clearIdle(core, s);
}

/** Retire the idle flag (and its clock), announcing only a change. */
export function clearIdle(core: SessionCore, s: Session): void {
  if (!s.info.idle) return;
  s.info.idle = false;
  s.info.idleSince = undefined;
  core.emit("updated", s.info);
}
