import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type HTMLAttributes, type ReactNode } from "react";
import { WrapText } from "lucide-react";
import { LS, lsBool, lsSetBool } from "./storage";
import { Button } from "./kit/Button";
import { columnFits } from "./tableFit";

/**
 * A markdown table in the reader (and the gallery's document preview).
 *
 * A table wider than the screen wraps its prose columns by default and keeps
 * short ones (numbers, labels) on one line — the rule is `tableFit.ts`. Only
 * a table that would NOT fit on one line per row gets the toggle; a table that
 * fits has nothing to toggle, so it draws no control. The choice is one
 * per-device preference (`LS.readerTableWrap`), shared by every table on
 * screen at once, so flipping one never leaves its neighbours disagreeing.
 */

type Align = "left" | "center" | "right";

// One preference, many tables: a tiny store so a flip redraws all of them.
const listeners = new Set<() => void>();
let wrapPref = lsBool(LS.readerTableWrap, true);
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const flipWrap = () => { wrapPref = !wrapPref; lsSetBool(LS.readerTableWrap, wrapPref); listeners.forEach((fn) => fn()); };

export function MdTable({ outer, header, body, aligns, cell }: {
  /** The block's own attributes (class + the review mode's line tags). */
  outer: HTMLAttributes<HTMLDivElement> & Record<string, unknown>;
  header: string[]; body: string[][]; aligns: Align[];
  /** Renders one cell's inline markdown; `r` is -1 for the header row. */
  cell: (text: string, r: number, c: number) => ReactNode;
}) {
  const wrap = useSyncExternalStore(subscribe, () => wrapPref);
  const cols = Math.max(header.length, ...body.map((r) => r.length));
  // The reader re-renders on every streamed frame with fresh arrays; key the
  // work on the CONTENT, so a table that did not change is not re-measured.
  const sig = JSON.stringify([header, body]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fits = useMemo(() => columnFits(body, cols), [sig]);
  const scroller = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLTableElement>(null);
  // Would one line per row overflow the box? Measured with the cells forced
  // to one line for the one read, then put back before paint.
  const [tooWide, setTooWide] = useState(false);
  useLayoutEffect(() => {
    const box = scroller.current, t = table.current;
    if (!box || !t) return;
    // Both are watched: the box for a rotation or a split pane, the table for
    // a reader zoom (`--ui-font`). The forced layout is gone before the frame
    // ends, so a measure never triggers the next one.
    const measure = () => {
      const w = box.clientWidth;
      t.classList.add("tr-measure");
      const over = t.offsetWidth > w + 1;
      t.classList.remove("tr-measure");
      setTooWide(over);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(t);
    return () => ro.disconnect();
  }, [sig]);

  const style = (c: number) => {
    const f = fits[c];
    return {
      textAlign: aligns[c] ?? "left",
      ...(wrap && f?.kind === "wrap" ? { minWidth: `${f.minCh}ch` } : {}),
    } as const;
  };
  const keepCls = (c: number) => (fits[c]?.kind === "keep" ? "tr-keep" : undefined);
  const at = (r: string[], c: number) => r[c] ?? "";

  return (
    <div {...outer}>
      {tooWide && (
        <div className="tr-table-head">
          <Button className={wrap ? "on" : undefined} aria-pressed={wrap} onClick={flipWrap}>
            <WrapText size={12} /> {wrap ? "wrapping lines" : "wrap lines"}
          </Button>
        </div>
      )}
      <div ref={scroller} className="tr-table-wrap">
        <table ref={table} className={`tr-table${wrap ? " tr-wrap" : ""}`}>
          <thead>
            <tr>{Array.from({ length: cols }, (_, c) => (
              <th key={c} style={style(c)}>{cell(at(header, c), -1, c)}</th>
            ))}</tr>
          </thead>
          <tbody>{body.map((r, ri) => (
            <tr key={ri}>{Array.from({ length: cols }, (_, c) => (
              <td key={c} className={keepCls(c)} style={style(c)}>{cell(at(r, c), ri, c)}</td>
            ))}</tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}
