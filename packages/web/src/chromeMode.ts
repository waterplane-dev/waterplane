/**
 * WHO IS HIDING THE CHROME, AND WHERE THAT IS ALLOWED TO MEAN ANYTHING.
 *
 * Two modes hide the same header, status line and toolbar: typing room (the
 * caret is in the compose box, so the rows go to the output) and full screen
 * (asked for by hand, on the terminal's own corner button). They are one
 * layout deliberately — the same class — so the pure part is which of them is
 * ON, and that is here rather than inline in `App` because every bug this has
 * had was a bug in the conjunction and not in the pixels.
 *
 * Three rules, each of them a reported failure:
 *
 * 1. THE MODE IS THE SESSION SCREEN'S. The strips it takes off the screen
 *    (`.net-pulse`, `.localrt-bar`) are mounted outside `App`'s tree and are
 *    hidden through an attribute on <html>, so a mode left switched on goes on
 *    hiding them on the launcher and behind every sheet — screens that draw no
 *    control to switch it off. Both hiders could leak there: `composeFocused`
 *    survives the back button (React fires no blur on unmount) and
 *    `fullScreen` is simply a switch nobody reset. So the gate is the SCREEN,
 *    once, rather than a reset per mode.
 * 2. TYPING ROOM OWNS THE CARET, SO IT WINS WHILE THE CARET IS IN THE BOX. The
 *    button still reads and writes `fullScreen`, the switch's own value — what
 *    it says and what it does are the same fact — but the LAYOUT has one
 *    hider at a time and typing room's way back is typing room's.
 * 3. THE PEEK SUSPENDS BOTH. The peek asks for the chrome back without giving
 *    up the caret; with full screen on it was asking one hider to let go while
 *    the other held on, so the ☰ appeared to do nothing and the only thing
 *    that worked was tapping it again after the keyboard went away. Leaving
 *    the peek resumes whatever was hiding before it.
 *
 * CLI mode is excluded from typing room for the reason `App` states: there the
 * box IS the keyboard and the special-key row is the rest of it.
 */
export type ChromeInput = {
  /** A session (or a pending one) is attached and no overlay covers it. */
  onSessionScreen: boolean;
  /** The preference, not the mode. */
  typingRoom: boolean;
  composeFocused: boolean;
  cliMode: boolean;
  /** Typing room suspended by hand. */
  typingPeek: boolean;
  /** The full-screen switch's OWN value. */
  fullScreen: boolean;
};

export type ChromeMode = {
  /** Typing room is hiding the chrome right now. */
  typingMode: boolean;
  /** Typing room is suspended and the header is drawn over the output. */
  typingPeeking: boolean;
  /** Full screen is hiding the chrome right now. */
  fullMode: boolean;
  /** Either of them is. The only thing the <html> attribute may key on. */
  chromeHidden: boolean;
};

export function chromeMode(i: ChromeInput): ChromeMode {
  const typing = i.onSessionScreen && i.typingRoom && i.composeFocused && !i.cliMode;
  const typingMode = typing && !i.typingPeek;
  const typingPeeking = typing && i.typingPeek;
  const fullMode = i.fullScreen && i.onSessionScreen && !typingMode && !typingPeeking;
  return { typingMode, typingPeeking, fullMode, chromeHidden: typingMode || fullMode };
}

/**
 * WHAT A TAP ON THE FULL-SCREEN BUTTON WRITES — and what the button SAYS.
 *
 * The button speaks for what is ON SCREEN (`chromeHidden`), not for either
 * switch. Drawing it from the `fullScreen` switch lied as soon as typing room
 * was in play: switch on, then ☰ peeked the header back — the button still
 * said "leave full screen" over a visible header, and its tap "left" into the
 * same picture. Flipping the switch alone was dead the other way too: in the
 * peek `fullMode` is suspended, so "enter" hid nothing.
 *
 * So a tap asks for the opposite of what is visible and moves BOTH hiders to
 * agree: hiding sets the switch and ends the peek (the keyboard stays up);
 * showing clears the switch and, while typing room is active, starts a peek
 * (the caret stays). The peek is never touched with the caret elsewhere — a
 * peek left set would make the NEXT focus open with the chrome up.
 */
export function fullScreenTap(i: ChromeInput): { fullScreen: boolean; typingPeek: boolean } {
  const { typingMode, typingPeeking, chromeHidden } = chromeMode(i);
  const hide = !chromeHidden;
  const typing = typingMode || typingPeeking;
  return { fullScreen: hide, typingPeek: typing ? !hide : i.typingPeek };
}

/**
 * THE KEYBOARD WENT AWAY BUT THE CARET STAYED.
 *
 * Android dismisses the soft keyboard on the back gesture WITHOUT blurring the
 * box, so `composeFocused` stayed true on a screen with no keyboard: typing
 * room kept the header, status line and special-key row hidden, which reads as
 * full screen with the key row missing — and the next tap on any corner button
 * blurred the box, brought all of it back and moved the button out from under
 * the finger before its click landed.
 *
 * Focus stays the signal for ENTERING typing room (an absolute keyboard
 * measurement is unreliable, see web.md). Leaving is RELATIVE to the viewport
 * the box was focused at: the keyboard counts as closed only once it has
 * provably OPENED (the viewport dropped a keyboard's worth below that baseline)
 * and the viewport is back at the baseline again. NOT "grew back from the
 * shortest seen": the keyboard's opening animation and its suggestion strip
 * move the height by more than a keyboard's worth on the way DOWN, and that
 * rule blurred the box while the keyboard was still opening — no typing at
 * all. The caller also only acts on a reading that has held still
 * (`KEYBOARD_SETTLE_MS`). A width change is a rotation: the tracker restarts.
 * Focus arriving with the keyboard already up never proves an opening, so it
 * never blurs — missing a close is the safe failure, a false close is not.
 */
export const KEYBOARD_GONE_PX = 120;
/** How long a viewport height must hold before it is believed. */
export const KEYBOARD_SETTLE_MS = 350;
/** Slack for "back at the baseline" (rounding, a toolbar pixel or two). */
const BASELINE_SLACK_PX = 40;

export type KbTrack = { baseH: number; minH: number; w: number };

export function trackKeyboard(
  prev: KbTrack | null,
  h: number,
  w: number,
): { next: KbTrack; closed: boolean } {
  if (!prev || Math.abs(prev.w - w) > 2) return { next: { baseH: h, minH: h, w }, closed: false };
  const next = { ...prev, minH: Math.min(prev.minH, h), w };
  const opened = next.baseH - next.minH >= KEYBOARD_GONE_PX;
  return { next, closed: opened && h >= next.baseH - BASELINE_SLACK_PX };
}
