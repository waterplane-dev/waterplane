/**
 * The reader's empty state, filled: the TOP of what the CLI has drawn so far.
 *
 * A fresh session opened in read mode has no turns, and "No turns recorded
 * yet." over a blank screen read as broken while the CLI was sitting there
 * with its welcome header and composer. So the reader shows the upper rows of
 * the live screen instead — read-only, tap to open the real terminal — and the
 * moment the first turn lands it flies into the CLI toggle (`leaving`), which
 * is the answer to "where did that go?" in one gesture.
 *
 * A DISPLAY, never a second terminal: no input, no fit, and above all NO
 * geometry report — the grid is sized to the geometry the PTY was last told
 * (`geomRef`), so the bytes wrap where the CLI drew them, and it is scaled with
 * CSS to the column width. Reporting a size from here would SIGWINCH the
 * session from a preview.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Terminal as TerminalIcon } from "lucide-react";
import { Empty } from "../../Empty";
import { onThemeChange, resolvedTheme } from "../../theme";
import { termTheme } from "../../termTheme";
import { termPx } from "../../uiScale";

/** At most this share of the reader's height — the "upper part", not a second console. */
const MAX_ROWS = 18;
const FLY_MS = 520;

/** The CLI view switch the peek flies into (`ScreenCorner` in TermArea.tsx). */
const TARGET = '[data-hint="term.read"]';

export function CliPeek({ chunks, writeSeq, cols, rows, leaving, onGone, onOpen }: {
  /** The session's PTY chunks — the same array the terminal view writes from. */
  chunks: string[];
  writeSeq: number;
  /** The geometry the PTY was last told, so lines wrap where the CLI drew them. */
  cols: number;
  rows: number;
  /** The first turn has landed: fly into the CLI toggle, then `onGone`. */
  leaving: boolean;
  onGone: () => void;
  onOpen: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const written = useRef<{ arr: string[] | null; n: number }>({ arr: null, n: 0 });
  /** Rows that carry text, counted from the top — the peek's height. */
  const [used, setUsed] = useState(0);
  const [scale, setScale] = useState(1);
  const [cellH, setCellH] = useState(0);

  // Created ONCE: a geometry change is a `resize` and a rewrite, never a new
  // xterm — disposing one mid-render threw out of its viewport sync and the
  // peek jumped for a frame.
  useEffect(() => {
    const term = new Terminal({
      cols: Math.max(20, cols), rows: Math.max(5, rows),
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: termPx(), theme: termTheme(resolvedTheme()),
      cursorBlink: false, disableStdin: true, scrollback: 0,
    });
    term.open(hostRef.current!);
    hostRef.current!.querySelector(".xterm-helper-textarea")?.setAttribute("inputmode", "none");
    termRef.current = term;
    written.current = { arr: null, n: 0 };
    const off = onThemeChange((t) => { term.options.theme = termTheme(t); });
    return () => { off(); termRef.current = null; term.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- geometry is applied below
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const w = written.current;
    const c = Math.max(20, cols), r = Math.max(5, rows);
    // A new geometry is a new screen at the new width; a replaced array (a full
    // replay on attach) is a new screen, not more of the old one.
    if (term.cols !== c || term.rows !== r) { term.resize(c, r); w.arr = null; }
    if (w.arr !== chunks || w.n > chunks.length) { term.reset(); w.arr = chunks; w.n = 0; }
    if (w.n >= chunks.length) return;
    for (let i = w.n; i < chunks.length; i++) term.write(chunks[i]);
    w.n = chunks.length;
    // Measure once the parser has drawn the batch.
    term.write("", () => {
      if (termRef.current !== term) return; // disposed before the parser got here
      // Mid-frame: claude wraps every redraw in synchronized output, and xterm
      // keeps painting the LAST whole frame until it closes — measuring the
      // half-drawn buffer here is what made the peek's height jump.
      if (term.modes.synchronizedOutputMode) return;
      const buf = term.buffer.active;
      let last = -1;
      for (let y = 0; y < term.rows; y++) {
        if (buf.getLine(buf.viewportY + y)?.translateToString(true).trim()) last = y;
      }
      setUsed(Math.min(MAX_ROWS, last + 1));
      const screen = hostRef.current?.querySelector<HTMLElement>(".xterm-screen");
      const box = boxRef.current;
      if (screen && box) {
        // offsetWidth/Height, never getBoundingClientRect: the screen sits
        // inside the scaled grid, so its rect is ALREADY scaled — feeding that
        // back flipped the scale between shrunk and 1 on every batch, and the
        // whole peek's text changed size each time the CLI wrote.
        const sw = screen.offsetWidth;
        setScale(sw > 0 ? Math.min(1, box.clientWidth / sw) : 1);
        setCellH(screen.offsetHeight / term.rows);
      }
    });
  }, [writeSeq, chunks, cols, rows]);

  // Into the toggle. Fixed at its current rect so the turn that just arrived
  // takes its place at once, then translated and squeezed onto the button.
  useLayoutEffect(() => {
    if (!leaving) return;
    const el = boxRef.current;
    const target = document.querySelector<HTMLElement>(TARGET);
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!el || !target || still || used === 0) { onGone(); return; }
    const from = el.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    Object.assign(el.style, {
      position: "fixed", left: `${from.left}px`, top: `${from.top}px`,
      width: `${from.width}px`, height: `${from.height}px`, margin: "0", zIndex: "40",
      transformOrigin: "top left", pointerEvents: "none",
    });
    const sx = to.width / from.width, sy = to.height / from.height;
    const anim = el.animate([
      { transform: "none", opacity: 1, borderRadius: "8px" },
      { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${sx}, ${sy})`, opacity: 0.35, borderRadius: "40px" },
    ], { duration: FLY_MS, easing: "cubic-bezier(.55,0,.25,1)", fill: "forwards" });
    anim.onfinish = () => {
      target.classList.add("cli-catch");
      window.setTimeout(() => target.classList.remove("cli-catch"), 450);
      onGone();
    };
    return () => { anim.onfinish = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per leave
  }, [leaving]);

  const height = used && cellH ? Math.ceil(used * cellH * scale) : 0;
  return (
    <div className="cli-peek-wrap">
      {!used && <Empty>No turns recorded yet.</Empty>}
      <div ref={boxRef} className={`cli-peek${used ? "" : " cli-peek-blank"}`} style={{ height }}
           role="button" tabIndex={0} aria-label="open the CLI"
           onClick={onOpen} onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}>
        <div ref={hostRef} className="cli-peek-grid" style={{ transform: `scale(${scale})` }} />
      </div>
      {used > 0 && !leaving && (
        <div className="cli-peek-cap muted">
          <TerminalIcon size={12} /> no turns yet — this is the top of the CLI; the conversation appears here once you send
        </div>
      )}
    </div>
  );
}
