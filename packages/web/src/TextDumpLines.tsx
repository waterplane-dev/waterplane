import { WrapText } from "lucide-react";
import { LS, lsBool, lsSetBool } from "./storage";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { Button } from "./kit/Button";

/**
 * The text dump as LINES, each with its own tick box.
 *
 * It was one textarea, and quoting the last line of a response meant a
 * long-press, two drag handles and a toolbar sitting on top of the very line
 * you were aiming at. A tick per line is one tap per line, and ticked lines
 * need not be adjacent.
 *
 * Wrapping is a toggle (`LS.textDumpWrap`, off by default): a grid is
 * already rows, and wrapping them again makes one row two ragged ones; a
 * transcript paragraph is one long line that wants it on. Unwrapped, the box
 * scrolls sideways.
 * The box opens scrolled to the BOTTOM — the end of the conversation is what
 * you came for.
 */
export interface TextDumpHandle {
  /** Ticked lines in order; else the text selected inside the box; else the whole dump. */
  pick(): { text: string; what: "ticked" | "selection" | "all" };
}

export const TextDumpLines = forwardRef<TextDumpHandle, { text: string }>(function TextDumpLines({ text }, ref) {
  // Trailing blank rows (the empty bottom of a terminal grid) would be what
  // "scrolled to the bottom" shows.
  const lines = text.replace(/\s+$/, "").split("\n");
  const [ticked, setTicked] = useState<Set<number>>(() => new Set());
  const boxRef = useRef<HTMLDivElement>(null);
  const [wrap, setWrap] = useState(() => lsBool(LS.textDumpWrap));
  const flipWrap = () => setWrap((w) => { lsSetBool(LS.textDumpWrap, !w); return !w; });

  // A new dump (re-pull, or the transcript arriving) is a new set of lines:
  // ticks by index would now point at different words.
  useEffect(() => { setTicked(new Set()); }, [text]);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);

  useImperativeHandle(ref, () => ({
    pick() {
      if (ticked.size) {
        return { text: [...ticked].sort((a, b) => a - b).map((i) => lines[i]).join("\n"), what: "ticked" };
      }
      const sel = window.getSelection();
      const box = boxRef.current;
      if (sel && !sel.isCollapsed && box && sel.anchorNode && box.contains(sel.anchorNode)) {
        return { text: sel.toString(), what: "selection" };
      }
      return { text, what: "all" };
    },
  }), [ticked, lines, text]);

  const toggle = (i: number) => setTicked((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });

  return (
    <>
      <div className="text-dump-bar">
        <button className={`key${wrap ? " on" : ""}`} aria-pressed={wrap} onClick={flipWrap}>
          <WrapText size={16} /> {wrap ? "wrapping lines" : "wrap lines"}
        </button>
      </div>
      {ticked.size > 0 && (
        <div className="text-dump-ticked">
          <span>{ticked.size} of {lines.length} lines ticked — copy and quote use only these.</span>
          <Button onClick={() => setTicked(new Set())}>clear</Button>
        </div>
      )}
      <div ref={boxRef} className={`text-dump text-dump-lines mono${wrap ? "" : " nowrap"}`}>
        {lines.map((l, i) => {
          const on = ticked.has(i);
          return (
            <div key={i} className={`tdl-row${on ? " on" : ""}`}>
              {l.trim()
                ? <label className="tdl-tick"><input type="checkbox" checked={on} onChange={() => toggle(i)} aria-label={`line ${i + 1}`} /></label>
                : <span className="tdl-tick" />}
              <span className="tdl-text">{l || " "}</span>
            </div>
          );
        })}
      </div>
    </>
  );
});
