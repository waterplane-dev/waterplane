/**
 * The backlog's knobs: idle wait, the automatic-session cap, the linger and the
 * reap thresholds. Split out of `backlog.ts` (move only).
 */
import { env } from "../env.js";

export const DEFAULT_IDLE_MS = Number(env("IDLE_MS") || 10000);

/**
 * How many AUTOMATIC sessions the host may have alive at once.
 *
 * The only thing standing between "a week of due work" and a dozen `claude`
 * processes starting inside one minute. Three is a working default for a solo
 * desktop: enough that two repos making progress never block a third, few enough
 * that the account is not spent in parallel by machinery nobody is watching. A
 * session the user opened with the sheet's own button counts too — the cap is
 * about how many agents are running, not about who asked for them.
 *
 * It used to be enforced inside a host-side refusal string (`openBacklogSession`
 * answering "waiting for a free backlog session — …open this repo's backlog
 * session yourself"). It is a RUNG now (`intentVerdict`'s `noSlot`, fed by
 * `IntentFacts.autoSlotsFree`), for the reason every other wait is one: a row
 * that is waiting deserves the same kind of sentence whatever it is waiting for,
 * and a second ladder living in a side door is a second ladder to keep in step.
 */
export const BACKLOG_SESSIONS_MAX = Math.max(1, Number(env("BACKLOG_SESSIONS") || 3));

/**
 * How long a finished item's session stays open before it is archived.
 *
 * Not a kill and not a `/clear`: `sessions.remove()` puts it under *Recently
 * closed*, where it reopens with `--continue`, and its conversation stays on
 * disk for `archive.ts` for ever. The ten minutes are for the person who walks
 * back to the desk and wants to see what the thing actually did — closing it the
 * instant the turn ended would make "open the session" a button that is never
 * there when anybody presses it.
 */
export const BACKLOG_LINGER_MS = Math.max(0, Number(env("BACKLOG_LINGER_MS") || 10 * 60_000));

/**
 * How quiet a session WITHOUT a hook pipe has to have been before the slot
 * count (`slotBusy`) reads it as idle — the silence fallback `autoFireBlocker`
 * applies when there is no `Stop` to go by.
 *
 * A minute: "it stopped printing a minute ago" is the only guard there is,
 * on such a session, against reading an agent between two tool calls as done.
 * A knob because the tests that pin the count cannot wait a minute three times
 * over; nothing else should ever set it.
 */
export const REAP_IDLE_MS = Math.max(0, Number(env("BACKLOG_REAP_IDLE_MS") || 60_000));

/**
 * The backstop over the CLI's own word about whether a session is free.
 *
 * `reapable()` asks `sessions.autoFireBlocker()` — which on a hooked session is
 * `turnActive`, i.e. the CLI saying "a turn is running". That is the right
 * answer and it has one failure mode: a `Stop` that never arrives (a killed
 * curl, a hook pipe that broke) leaves `turnActive` set for the life of the
 * process, and the session would then hold one of the desktop's automatic slots
 * until a restart. So PTY silence this long overrides the CLI's word.
 *
 * Six times the linger, an hour at the shipped default: far past any real tool
 * call or permission box, and the exchange is one lost conversation against a
 * slot held for ever.
 */
export const REAP_CEILING_MS = 6 * BACKLOG_LINGER_MS;
