/**
 * The session screen's chrome state — typing room, its peek, full screen and
 * the dismissed reply suggestion — as ONE hook App calls once.
 *
 * It is a hook in App and not state inside `SessionScreen` on purpose: App
 * returns early for every overlay, so the screen UNMOUNTS whenever a sheet is on
 * top, and three of these must outlive that. Full screen is a mode you are IN
 * until you leave the SESSION (not until you open a sheet), and a dismissed
 * reply stays dismissed across a trip to Settings. Holding them here keeps the
 * exact lifetimes they had as App's `useState`s.
 *
 * The conjunction of the hiders is `chromeMode.ts`'s, pure and node-tested —
 * every bug here was a bug in the conjunction. What this adds is the effects
 * that feed it, in the order App ran them.
 */
import { useEffect, useState, type RefObject } from "react";
import type { SessionInfo } from "@waterplane/shared";
import { chromeMode, trackKeyboard, KEYBOARD_SETTLE_MS, type KbTrack } from "../../chromeMode";
import { usePref } from "../prefs";

export interface SessionChromeDeps {
  activeId: string | null;
  active: SessionInfo | null | undefined;
  composeFocused: boolean;
  setComposeFocused(v: boolean): void;
  composeRef: RefObject<HTMLTextAreaElement | null>;
  cliMode: boolean;
}

export function useSessionChrome(d: SessionChromeDeps) {
  const { activeId, active, composeFocused, setComposeFocused, composeRef, cliMode } = d;
  const [dismissedReply, setDismissedReply] = useState(""); // free-text reply suggestion hidden by the user
  // Typing room: while the compose box has focus — which on a phone means the
  // on-screen keyboard is up and has taken half the screen — the chrome ABOVE
  // the box is hidden and the terminal keeps its rows. Measured on the device
  // this is for: header, status line, special-key row, the new-images strip and
  // the download strip together left the terminal TWO visible lines, so the
  // context you are typing about is exactly what is not on screen while you
  // type. What survives is the output and one button (the outline), because
  // "where am I in this conversation?" is the one question you ask mid-prompt.
  //
  // The way out is a tap on the terminal: blurring the box ends typing mode and
  // the chrome comes straight back. Nothing is destroyed and nothing is
  // persisted — it is a display state that lasts exactly as long as the caret
  // is in the box.
  //
  // Default splits on POINTER: a desktop keyboard costs no screen, so there is
  // nothing to give back there. Read once at mount and never re-derived — a flag
  // that flipped on a resize would silently undo a choice made by hand.
  const typingRoom = usePref("typingRoom");
  /**
   * The same room typing mode gives back, asked for WITHOUT the keyboard.
   *
   * Typing room is a side effect of composing: it hides the chrome because the
   * caret is in the box, and it ends when the caret leaves. Reading a long turn
   * on a phone wants exactly that layout and none of the reason for it —
   * putting the caret in the box to see more output costs half the screen to
   * the keyboard, which is the thing being asked for back.
   *
   * Not persisted, deliberately. It is a mode you are IN, not a preference
   * (`typingRoom` above is the preference), and a phone that boots into a
   * hidden-chrome session with one small corner button as the way out is a
   * worse first frame than one extra tap.
   */
  const [fullScreen, setFullScreen] = useState(false);
  // Typing room, suspended by hand: the chrome comes back WITHOUT giving up the
  // caret or the keyboard. Blurring can't be the way to see the header again —
  // the box is already focused, so tapping it fires no focus event and the
  // chrome would stay up until you deliberately blurred and re-focused. So it
  // is its own state, and it is transient: it resets whenever the caret leaves
  // the box or the session changes, and the next focus starts hidden again.
  const [typingPeek, setTypingPeek] = useState(false);
  /**
   * A sheet is DRAWN over the session — not "an overlay name is set". The
   * overlay table answers a miss with null and the session screen paints
   * underneath (`overlayViews.tsx`): an `image` or `collage` route whose
   * picture is gone after a mark-and-send. Gating on the NAME then left
   * `onSessionScreen` false on a screen showing the session, and the full-screen
   * button flipped its switch into a mode that refused to apply — a dead tap
   * with nothing on screen to say why. App reports what it drew through
   * `drawnSheet` in the same render (a set-during-render, so the corrected
   * frame is the first one committed).
   */
  const [sheetDrawn, setSheetDrawn] = useState(false);
  const drawnSheet = <T,>(node: T): T => {
    if (!!node !== sheetDrawn) setSheetDrawn(!!node);
    return node;
  };
  /**
   * The session screen is on top: a session (or a pending one) is attached and
   * no sheet is drawn over it.
   *
   * Everything that hides chrome is scoped to this — see `chromeMode.ts`,
   * which holds that rule, the two others it lives with, and the failures each
   * of them is. The conjunction is pure and node-tested because every bug this
   * has had was a bug in the conjunction.
   */
  const onSessionScreen = !!active && !sheetDrawn;
  const chromeIn = { onSessionScreen, typingRoom, composeFocused, cliMode, typingPeek, fullScreen };
  const { typingMode, typingPeeking, fullMode, chromeHidden } = chromeMode(chromeIn);
  /* The net-pulse strip is mounted in `main.tsx`, outside this tree, and every
     screen makes room for it through `--ui-pulse-h` — so hiding it needs a
     signal on the document rather than a class on this subtree. */
  useEffect(() => {
    const root = document.documentElement;
    if (chromeHidden) root.dataset.typing = "1"; else delete root.dataset.typing;
    return () => { delete root.dataset.typing; };
  }, [chromeHidden]);
  /* A sheet unmounts the compose box without firing a blur, which would
     leave the chrome hidden on a screen with no caret in it. */
  useEffect(() => { if (sheetDrawn) setComposeFocused(false); }, [sheetDrawn]); // eslint-disable-line react-hooks/exhaustive-deps -- `setComposeFocused` is the compose hook's setter
  useEffect(() => { if (!composeFocused) setTypingPeek(false); }, [composeFocused]);
  /* The back gesture hides Android's keyboard and leaves the caret in the box,
     so focus alone kept typing room up on a screen with no keyboard — the key
     row gone and the header hidden, which read as a broken full screen. The
     viewport growing back while focused is the keyboard leaving: blur, and the
     layout follows what is actually on screen (`trackKeyboard`). */
  useEffect(() => {
    if (!composeFocused) return;
    const vv = window.visualViewport;
    let t: KbTrack | null = null;
    let settle = 0;
    const read = () => trackKeyboard(t, vv?.height ?? window.innerHeight, vv?.width ?? window.innerWidth);
    // Every reading feeds the tracker (so the opening is SEEN), but a close is
    // acted on only when the height has held still — mid-animation readings
    // are not a keyboard state.
    const check = () => {
      t = read().next;
      clearTimeout(settle);
      settle = window.setTimeout(() => { const r = read(); t = r.next; if (r.closed) composeRef.current?.blur(); }, KEYBOARD_SETTLE_MS);
    };
    t = read().next;
    vv?.addEventListener("resize", check);
    window.addEventListener("resize", check);
    return () => { clearTimeout(settle); vv?.removeEventListener("resize", check); window.removeEventListener("resize", check); };
  }, [composeFocused]); // eslint-disable-line react-hooks/exhaustive-deps -- bound while the box has focus; `composeRef` is a ref
  useEffect(() => { setTypingPeek(false); }, [activeId]);
  /* Full screen ends when the session does. `fullMode` already refuses to apply
     off the session screen, so this is not what keeps the launcher's strips on
     screen — it is what keeps the mode from being a fact you cannot see: coming
     back to a session and finding the header gone, with no memory of asking for
     it, is the state-management bug and not its symptom. */
  useEffect(() => { if (!activeId) setFullScreen(false); }, [activeId]);
  return {
    fullScreen, setFullScreen, typingPeek, setTypingPeek, dismissedReply, setDismissedReply,
    typingMode, typingPeeking, fullMode, chromeHidden, chromeIn, drawnSheet,
  };
}

export type SessionChrome = ReturnType<typeof useSessionChrome>;
