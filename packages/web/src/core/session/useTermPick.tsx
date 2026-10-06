/**
 * Picking lines ON the live terminal, and the long-press that offers it.
 *
 * The Terminal-text sheet already ticks lines — but as a plain-text copy of the
 * grid in a sheet of its own, where the colours, the bold and the layout that
 * made a line findable are gone, so every pick began with finding the line
 * again. Here the ticks are drawn over the CLI's own rows. The gutter lives
 * INSIDE the terminal's element (`TerminalView`'s `children`), so a pan that
 * starts on it still scrolls the TUI; a tap toggles the row under it.
 *
 * Picks are held by their TEXT, not their row: under tmux a scroll redraws the
 * grid and every row moves. After each repaint a pick is found again (same
 * text, nearest row); one that scrolled away is still picked and still quoted,
 * and the bar says how many are out of sight.
 *
 * A long-press opens the choices (`pickUi.tsx`) next to the phone's own
 * selection, which is deliberately NOT prevented — "select text" leaves it alone.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Check } from "lucide-react";
import type { RowBox, TerminalHandle } from "../../Terminal";
import { track } from "../../usage";
import { PickBar, PickMenu, type MenuAt } from "./pickUi";

/** A repaint is a burst of writes; read the grid once it has had a moment. */
const REREAD_MS = 150;

interface Pick { text: string; row: number }

/** Find each pick again on a new grid: its old row if the text is still there,
 *  else the nearest unclaimed row with the same text, else off screen (-1). */
function relocate(picks: readonly Pick[], grid: readonly string[]): Pick[] {
  const used = new Set<number>();
  return picks.map((p) => {
    if (p.row >= 0 && grid[p.row] === p.text && !used.has(p.row)) { used.add(p.row); return p; }
    let best = -1;
    grid.forEach((t, j) => {
      if (t === p.text && !used.has(j) && (best < 0 || Math.abs(j - p.row) < Math.abs(best - p.row))) best = j;
    });
    if (best >= 0) used.add(best);
    return { text: p.text, row: best };
  });
}

export function useTermPick(termRef: RefObject<TerminalHandle | null>, writeSeq: number, sessionId: string): {
  onLongPress: (row: number, x: number, y: number) => void;
  gutter: ReactNode;
  chrome: ReactNode;
} {
  const [menu, setMenu] = useState<(MenuAt & { row: number }) | null>(null);
  const [picking, setPicking] = useState(false);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [view, setView] = useState<{ grid: string[]; box: RowBox | null }>({ grid: [], box: null });
  const timer = useRef<number | undefined>(undefined);

  const reread = () => {
    const t = termRef.current;
    if (!t) return;
    const grid = t.snapshot();
    setView({ grid, box: t.rowBox() });
    setPicks((ps) => (ps.length ? relocate(ps, grid) : ps));
  };

  // Another session is another screen: nothing picked there carries over.
  useEffect(() => { setMenu(null); setPicking(false); setPicks([]); }, [sessionId]);

  useEffect(() => {
    if (!picking) return;
    clearTimeout(timer.current);
    timer.current = window.setTimeout(reread, REREAD_MS);
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking, writeSeq]);

  useEffect(() => {
    if (!picking) return;
    const onResize = () => { clearTimeout(timer.current); timer.current = window.setTimeout(reread, REREAD_MS); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking]);

  const toggle = (row: number) => {
    const text = view.grid[row];
    if (!text?.trim()) return;
    setPicks((ps) => ps.some((p) => p.row === row) ? ps.filter((p) => p.row !== row) : [...ps, { text, row }]);
  };

  const startPicking = (row?: number) => {
    track("action:termpick.start");
    window.getSelection()?.removeAllRanges();
    setMenu(null);
    const t = termRef.current;
    const grid = t?.snapshot() ?? [];
    setView({ grid, box: t?.rowBox() ?? null });
    setPicks(row != null && grid[row]?.trim() ? [{ text: grid[row], row }] : []);
    setPicking(true);
  };
  const stop = () => { setPicking(false); setPicks([]); };
  const closeMenu = useCallback(() => setMenu(null), []);

  /** Screen order while every pick is on screen; pick order once one is not —
   *  there is no row left to sort that one by. */
  const pickedText = (): string[] =>
    (picks.every((p) => p.row >= 0) ? [...picks].sort((a, b) => a.row - b.row) : picks).map((p) => p.text);

  const onLongPress = (row: number, x: number, y: number) => {
    if (picking) return; // a tap already toggles; a long one is not a different verb here
    setMenu({ row, x, y });
  };

  const on = new Set(picks.filter((p) => p.row >= 0).map((p) => p.row));
  const off = picks.filter((p) => p.row < 0).length;
  const { box, grid } = view;

  const gutter = picking && box ? (
    <div className="tpick-layer" style={{ top: box.top, left: box.left, width: box.width, height: box.rowH * box.rows }}>
      {Array.from({ length: box.rows }, (_, r) => {
        const tickable = !!grid[r]?.trim();
        return (
          <div key={r} className={`tpick-row${on.has(r) ? " on" : ""}`} style={{ height: box.rowH }}
            onClick={(e) => { e.stopPropagation(); toggle(r); }}>
            {tickable && <span className="tpick-box" style={{ width: box.rowH - 3, height: box.rowH - 3 }}>
              {on.has(r) && <Check size={Math.max(10, box.rowH - 5)} strokeWidth={3} />}
            </span>}
          </div>
        );
      })}
    </div>
  ) : null;

  const menuEl = menu && <PickMenu at={menu} onPick={() => startPicking(menu.row)} onCancel={closeMenu} />;
  const bar = picking && (
    <PickBar count={picks.length} off={off} hint="tap lines to pick them — panning still scrolls" lines={pickedText} onStop={stop} />
  );

  return { onLongPress, gutter, chrome: <>{menuEl}{bar}</> };
}
