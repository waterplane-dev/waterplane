import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { onThemeChange, resolvedTheme } from "./theme";
import { termTheme } from "./termTheme";
import { onUiScale, termPx } from "./uiScale";
import { cappedCols, drawableViewport } from "@waterplane/shared";

interface Props {
  /** Raw PTY chunks to write. Parent bumps `writeSeq` to push new data. */
  pending: string[];
  writeSeq: number;
  /** Local keystrokes typed into the terminal (hardware keyboard). */
  onInput: (data: string) => void;
  /** Reports terminal geometry on fit so the host can resize the PTY. */
  onResize: (cols: number, rows: number) => void;
  /** Socket state. Scrolling the alt screen is a REMOTE operation (wheel bytes
   *  the TUI consumes), so with the link down it has to go somewhere else. */
  linkUp: boolean;
  /** One settled screen snapshot, for the local scrollback reconstruction
   *  (screenlog.ts). Fires after a repaint stops moving, not per write. */
  onScreen?: (lines: string[]) => void;
  /** The cursor's row up to the cursor, once output settles — either buffer.
   *  What a program waiting on a line just printed (`secretAsk.ts`). */
  onCursorLine?: (line: string) => void;
  /** The user panned up while the wheel had nowhere to go — open local history. */
  onReachBack?: () => void;
  /** An upward pan WAS sent and the screen never moved — a crawling link, or the
   *  top of the TUI's own history. Either way there is a local copy to offer. */
  onScrollStalled?: () => void;
  /** A finger held still on the grid (`LONG_PRESS_MS`): the visible row under
   *  it and the touch point. Native selection is NOT prevented — the caller
   *  offers its own choices next to it. */
  onLongPress?: (row: number, clientX: number, clientY: number) => void;
  /** Drawn INSIDE the terminal's own element, over the grid, so a pan that
   *  starts on it still scrolls the TUI (the touch handlers are on this
   *  element and the events bubble to them). */
  children?: ReactNode;
}

export interface TerminalHandle {
  /** Plain-text dump of both buffers (normal scrollback + current alt screen). */
  getText(): string;
  /** The visible grid as text, right now. */
  snapshot(): string[];
  /** Where the visible rows are drawn, relative to the terminal's element. */
  rowBox(): RowBox | null;
  /** Give the grid the keyboard (a desktop key typed at nothing, `strayKeys.ts`). */
  focus(): void;
}

export interface RowBox { top: number; left: number; width: number; rowH: number; rows: number }

/** How long a still finger is a long-press, not a tap. Under Android's own
 *  long-press (~500 ms), so the choices appear with the native selection. */
const LONG_PRESS_MS = 450;

/** How long the writes must stop before the grid is read for the local
 *  scrollback. Long enough that a streaming answer isn't sampled mid-line,
 *  short enough that a fast-scrolling burst still gets sampled as it goes. */
const SNAPSHOT_SETTLE_MS = 400;

/** How long an upward pan may leave the screen unmoved before the local
 *  scrollback is mentioned. Well past a healthy round trip, short enough to
 *  answer the gesture rather than the next one. */
const SCROLL_STALL_MS = 2500;
/** …and how long before it may be said again. Panning against a dead link is
 *  one situation, not one per flick. */
const SCROLL_STALL_COOLDOWN_MS = 30_000;

/** The VISIBLE grid as text — what a screenshot would show, not the buffer. */
function gridText(term: Terminal): string[] {
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let y = 0; y < term.rows; y++) {
    const ln = buf.getLine(buf.viewportY + y);
    out.push(ln ? ln.translateToString(true).replace(/\s+$/, "") : "");
  }
  return out;
}

/** The drawn rows' box, relative to `host` — measured off `.xterm-screen`, so
 *  padding and the fit's leftover pixels are the renderer's, not a guess. */
function rowBoxOf(host: HTMLElement, term: Terminal): RowBox | null {
  const scr = host.querySelector<HTMLElement>(".xterm-screen");
  if (!scr || !term.rows) return null;
  const h = host.getBoundingClientRect(), r = scr.getBoundingClientRect();
  if (!r.height) return null;
  return { top: r.top - h.top, left: r.left - h.left, width: r.width, rowH: r.height / term.rows, rows: term.rows };
}

/** xterm.js wrapper sized to fill its container, tuned for touch. */
export const TerminalView = forwardRef<TerminalHandle, Props>(function TerminalView({ pending, writeSeq, onInput, onResize, linkUp, onScreen, onCursorLine, onReachBack, onScrollStalled, onLongPress, children }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenRef = useRef(0);
  // Last geometry actually reported to the host. A resize is a SIGWINCH and a
  // SIGWINCH makes the claude TUI clear and repaint the whole screen, so a
  // report that says nothing new is a full-screen flicker for free. The
  // observer fires on every layout change of the container — a status bar
  // mounting above the terminal, the queue bar appearing for one send, the
  // keyboard closing — and most of those land back on the SAME cols/rows once
  // the grid is rounded to whole cells.
  const geomRef = useRef({ cols: 0, rows: 0 });
  // Read inside the touch handlers, which are bound once for the terminal's
  // lifetime and would otherwise capture the mount-time values for ever.
  const liveRef = useRef({ linkUp, onScreen, onCursorLine, onReachBack, onScrollStalled, onLongPress });
  liveRef.current = { linkUp, onScreen, onCursorLine, onReachBack, onScrollStalled, onLongPress };
  /** Snapshot timer. A claude repaint is a burst of writes, and the grid is
   *  only worth reading once it stops moving — mid-repaint it is half-drawn. */
  const snapTimer = useRef<number | undefined>(undefined);
  /** Armed by an upward wheel send, disarmed by the repaint it should cause. */
  const stallTimer = useRef<number | undefined>(undefined);
  const lastStall = useRef(0);

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      // The terminal is a CANVAS: a custom property means nothing to it, so the
      // size has to be read and pushed rather than inherited. It follows the
      // app's text scale (eyesight is not per surface) TIMES the console's own
      // zoom — `uiScaleSteps.ts` argues why that is a second knob: a smaller
      // font here is a bigger GRID, which is what "I want to see more on
      // screen" actually asks for.
      fontSize: termPx(),
      theme: termTheme(resolvedTheme()),
      scrollback: 5000,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // The fit, never wider than `MAX_PTY_COLS`: on a desktop pane the grid sits
    // left and the rest is margin. AFTER the fit, so the console zoom's bigger
    // grid is still a bigger grid up to the cap.
    const fitGrid = () => {
      fit.fit();
      if (term.cols > cappedCols(term.cols)) term.resize(cappedCols(term.cols), term.rows);
    };
    term.open(hostRef.current!);
    // All input flows through the compose bar + special-keys row over the WS,
    // never through xterm's own keyboard. Its hidden helper textarea otherwise
    // summons the mobile on-screen keyboard whenever it gains focus (e.g. a
    // special-key tap). inputmode=none keeps the textarea focusable for paste
    // and hardware keys but stops it raising the virtual keyboard.
    hostRef.current!.querySelector(".xterm-helper-textarea")?.setAttribute("inputmode", "none");
    fitGrid();
    // Ctrl+C over a SELECTION copies it — what every desktop terminal does —
    // instead of sending ^C, which would interrupt the turn you were reading.
    // With nothing selected it is ^C, as before. Copy needs a secure context;
    // without one the key is still swallowed, never turned into an interrupt.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey || e.shiftKey || e.altKey || e.key.toLowerCase() !== "c" || !term.hasSelection()) return true;
      void navigator.clipboard?.writeText(term.getSelection()).catch(() => { /* not a secure context */ });
      return false;
    });
    term.onData(onInput);
    termRef.current = term;
    // Light/dark applied to a LIVE grid. `term.options.theme` is a full
    // re-assignment (xterm has no per-key setter), and the renderer repaints the
    // whole screen from its own buffer — no host round trip, nothing lost, so a
    // switch mid-session is safe while a turn is streaming.
    const offTheme = onThemeChange((t) => { term.options.theme = termTheme(t); });
    // Same live-grid treatment the theme gets, plus a refit: changing the cell
    // size changes cols/rows, and the geometry report that follows is what tells
    // the host to resize the PTY. One repaint, on a deliberate setting change.
    const offScale = onUiScale(() => {
      term.options.fontSize = termPx();
      try { fitGrid(); } catch { return; /* detached */ }
      // And TELL THE HOST. A cell-size change is a geometry change: the whole
      // point of zooming out is the extra cols and rows, and the PTY only gets
      // them from this report. Without it xterm drew a wider grid the CLI knew
      // nothing about, so the TUI kept painting at the old size and the new
      // space stayed blank — the setting looked like it did half its job.
      report(term.cols, term.rows);
    });
    fitRef.current = fit;
    report(term.cols, term.rows);

    // Debounce: the mobile keyboard opening/closing fires a burst of resizes.
    let resizeTimer: number | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        try {
          const stick = atBottom();
          fitGrid();
          report(term.cols, term.rows);
          if (stick) term.scrollToBottom(); // only follow if user wasn't scrolled up
        } catch { /* not yet laid out */ }
      }, 150);
    });
    ro.observe(hostRef.current!);

    // Under tmux the outer terminal is in the ALTERNATE buffer (the tmux client
    // emits `?1049h`), so xterm has no scrollback of its own to pan. Translate
    // touch into SGR mouse-wheel writes and let the HOST decide who reads them
    // (`host/tmuxscroll.ts`): claude ≥ 2.1 enables `?1003h`+`?1006h` and scrolls
    // itself, so the bytes are passed through to it; a pane that asked for no
    // mouse gets tmux copy-mode scroll instead. Either way the client's job is
    // the same one write. 8px deadzone + horizontal-dominant moves fall through
    // so other gestures and single-finger taps still register.
    const host = hostRef.current!;
    let touchY = 0, touchX = 0, accumPx = 0, scrolling = false;
    let pressTimer: number | undefined;
    const cancelPress = () => { clearTimeout(pressTimer); pressTimer = undefined; };
    /** The top visible row as text — the cheap "did the view move?" probe. */
    const topRow = (): string => {
      const buf = term.buffer.active;
      return buf.getLine(buf.viewportY)?.translateToString(true) ?? "";
    };
    const cellH = () => {
      const v = host.querySelector<HTMLElement>(".xterm-rows > div");
      return v?.getBoundingClientRect().height || 16;
    };
    const sendWheel = (lines: number) => {
      // SGR wheel: button 64=up, 65=down. Press event ("M") at col/row 1.
      // ONE write for the whole flick: a fast pan is a dozen lines, and a dozen
      // separate `session.input` frames is a dozen round trips on a link that
      // is already the reason scrolling feels broken.
      const code = lines < 0 ? 64 : 65;
      onInput(`\x1b[<${code};1;1M`.repeat(Math.abs(lines)));
      // A scroll is only real once the TUI redraws. On a link slow enough to be
      // the reason someone is reading this, and at the top of the TUI's own
      // history, the answer is the same: nothing moves and the gesture looks
      // broken. Say where the local copy is — once per gesture, and never
      // pre-empting the sheet with an auto-open, since the bytes may still land.
      if (lines >= 0) return;
      // What "the screen moved" MEANS matters here. This used to be disarmed by
      // any incoming write, which on a busy session is a spinner frame several
      // times a second — so the one escape hatch was unreachable in exactly the
      // case that needs it: a session with two agents running and a pan that
      // does nothing. The TOP visible row is the discriminator: a repaint in
      // place does not change it, a scroll does.
      clearTimeout(stallTimer.current);
      const before = topRow();
      stallTimer.current = window.setTimeout(() => {
        if (topRow() !== before) return;                                        // it scrolled; nothing to say
        if (Date.now() - lastStall.current < SCROLL_STALL_COOLDOWN_MS) return; // one nudge, not a stream of them
        lastStall.current = Date.now();
        liveRef.current.onScrollStalled?.();
      }, SCROLL_STALL_MS);
    };
    const onTouchStart = (e: TouchEvent) => {
      cancelPress();
      if (e.touches.length !== 1) { scrolling = false; return; }
      touchY = e.touches[0].clientY;
      touchX = e.touches[0].clientX;
      accumPx = 0;
      scrolling = false;
      const x = touchX, y = touchY;
      pressTimer = window.setTimeout(() => {
        pressTimer = undefined;
        const box = rowBoxOf(host, term);
        if (!box) return;
        const row = Math.floor((y - host.getBoundingClientRect().top - box.top) / box.rowH);
        if (row >= 0 && row < box.rows) liveRef.current.onLongPress?.(row, x, y);
      }, LONG_PRESS_MS);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const dy = e.touches[0].clientY - touchY;
      const dx = e.touches[0].clientX - touchX;
      if (pressTimer !== undefined && Math.hypot(dx, dy) > 8) cancelPress();
      if (!scrolling) {
        if (Math.abs(dy) < 8 || Math.abs(dx) > Math.abs(dy)) return; // not a vertical pan yet
        scrolling = true;
      }
      e.preventDefault();
      accumPx -= dy;
      touchY = e.touches[0].clientY;
      const ch = cellH();
      const lines = Math.trunc(accumPx / ch);
      if (lines !== 0) {
        accumPx -= lines * ch;
        // Fall back to xterm's own scrollback in normal-buffer apps (bash etc).
        if (term.buffer.active.type === "normal") { term.scrollLines(lines); return; }
        // No socket ⇒ the wheel bytes would be dropped on the floor and the
        // screen would sit there, unmoved, looking like a broken gesture. Hand
        // the pan to the locally reconstructed scrollback instead; a downward
        // pan is left alone (there is nothing below the live screen).
        if (!liveRef.current.linkUp) {
          if (lines < 0) { scrolling = false; liveRef.current.onReachBack?.(); }
          return;
        }
        sendWheel(lines);
      }
    };
    host.addEventListener("touchstart", onTouchStart, { passive: true });
    host.addEventListener("touchmove", onTouchMove, { passive: false });
    host.addEventListener("touchend", cancelPress, { passive: true });
    host.addEventListener("touchcancel", cancelPress, { passive: true });

    return () => {
      // One last read before the grid goes away: leaving a session unmounts
      // this, and whatever was on screen is the newest history there will be.
      try { if (term.buffer.active.type === "alternate") liveRef.current.onScreen?.(gridText(term)); } catch { /* disposed mid-teardown */ }
      clearTimeout(resizeTimer);
      clearTimeout(snapTimer.current);
      clearTimeout(stallTimer.current);
      ro.disconnect();
      offTheme();
      offScale();
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
      host.removeEventListener("touchend", cancelPress);
      host.removeEventListener("touchcancel", cancelPress);
      cancelPress();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: TermArea keys this view per session, so `onInput` and `report`'s `onResize` are that session's; the touch handlers read `liveRef`
  }, []);

  // Flush any not-yet-written chunks whenever the parent signals new data.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (writtenRef.current >= pending.length) return;
    const stick = atBottom();
    for (let i = writtenRef.current; i < pending.length; i++) term.write(pending[i]);
    writtenRef.current = pending.length;
    if (stick) term.scrollToBottom();
    // Read the grid once the repaint settles. The alt screen only: a normal
    // buffer keeps its own scrollback, which pans locally with no host at all.
    clearTimeout(snapTimer.current);
    snapTimer.current = window.setTimeout(() => {
      if (!termRef.current) return;
      if (liveRef.current.onCursorLine && !termRef.current.modes.synchronizedOutputMode) {
        const b = termRef.current.buffer.active;
        liveRef.current.onCursorLine(b.getLine(b.baseY + b.cursorY)?.translateToString(true, 0, b.cursorX) ?? "");
      }
      if (termRef.current.buffer.active.type !== "alternate") return;
      // Inside a synchronized-output frame (`?2026h` … `?2026l`, which claude
      // wraps every redraw in) the buffer is half-drawn; the write that closes
      // it re-arms this timer.
      if (termRef.current.modes.synchronizedOutputMode) return;
      liveRef.current.onScreen?.(gridText(termRef.current));
    }, SNAPSHOT_SETTLE_MS);
  }, [writeSeq, pending]);

  /**
   * Tell the host only when the grid actually changed size — and only when the
   * grid is one a person is looking at.
   *
   * `fit.fit()` divides the container by the cell size, and it answers just as
   * confidently for a container with no height: a sheet open over the terminal,
   * the reader view, a WebView still laying out. That is where `54x3` came
   * from, and three rows is not a small terminal — it is a terminal the CLI
   * cannot draw its composer in, so nothing typed into that session can be read
   * back and every send goes `unconfirmed` (`@waterplane/shared`'s `ptysize.ts`).
   *
   * Withholding the report costs nothing: the layout change that ends the
   * collapse fires another one, and `session.attach` re-states the geometry on
   * reconnect. `geomRef` is deliberately NOT updated here — the last size the
   * host was told stays the last size we believe it has, so the report that
   * follows the collapse is not skipped as a no-change.
   */
  function report(cols: number, rows: number) {
    if (!drawableViewport(cols, rows)) return;
    const last = geomRef.current;
    if (last.cols === cols && last.rows === rows) return;
    geomRef.current = { cols, rows };
    onResize(cols, rows);
  }

  function atBottom(): boolean {
    const term = termRef.current;
    if (!term) return true;
    // viewportY = top visible row; baseY = top of the live region. Equal → at bottom.
    return term.buffer.active.viewportY >= term.buffer.active.baseY;
  }

  useImperativeHandle(ref, () => ({
    focus(): void {
      termRef.current?.focus();
    },
    snapshot(): string[] {
      return termRef.current ? gridText(termRef.current) : [];
    },
    rowBox(): RowBox | null {
      return termRef.current && hostRef.current ? rowBoxOf(hostRef.current, termRef.current) : null;
    },
    getText(): string {
      const term = termRef.current;
      if (!term) return "";
      const dump = (which: "normal" | "alternate"): string => {
        const buf = term.buffer[which];
        const out: string[] = [];
        for (let i = 0; i < buf.length; i++) {
          const ln = buf.getLine(i);
          if (ln) out.push(ln.translateToString(true));
        }
        // Trim trailing blank lines so the dump ends at real content.
        while (out.length && out[out.length - 1] === "") out.pop();
        return out.join("\n");
      };
      const normal = dump("normal");
      const alt = term.buffer.active.type === "alternate" ? dump("alternate") : "";
      return [normal, alt].filter(Boolean).join("\n\n— current screen —\n\n");
    },
  }), []);

  return <div ref={hostRef} style={{ width: "100%", height: "100%", position: "relative" }}>{children}</div>;
});
