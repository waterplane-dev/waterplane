/**
 * "Pick lines" in the READER — the terminal's pick (`useTermPick.tsx`) for a
 * view whose lines are not rows but blocks: a paragraph, a list item, a
 * heading, a quote, a code block. Long-press opens the same menu; in pick mode
 * a tap ticks the block under it (its link or button is not followed — the
 * tap is a pick now), and panning scrolls as ever.
 *
 * The tick is a data attribute set on the block itself, so it is drawn where
 * the words are and costs `TranscriptView` nothing. A block the reader
 * re-renders away keeps its text in the pick — it is still quoted — and the
 * bar counts it as out of view, like a terminal row that scrolled off.
 *
 * An ordered list's numbers are the browser's, not the text's, so they are put
 * back on ("4. …") — that number is what the answer sheet keys an item by.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { track } from "../../usage";
import { bindLongPress, PickBar, PickMenu, type MenuAt } from "./pickUi";

/** What counts as one line in the reader (`Markdown.tsx`'s block classes). */
const BLOCKS = ".tr-body .tr-p, .tr-body .tr-list > li, .tr-body .tr-h, .tr-body .tr-quote, .tr-body .tr-code";
const MARK = "tpick";

interface Pick { el: HTMLElement; text: string }

function blockText(el: HTMLElement): string {
  const t = el.innerText.trim();
  const ol = el.tagName === "LI" ? el.parentElement : null;
  if (ol?.tagName !== "OL") return t;
  const start = Number((ol as HTMLOListElement).start) || 1;
  return `${start + [...ol.children].indexOf(el)}. ${t}`;
}

/** `shown`: whether the reader is mounted — the ref is filled only then, and
 *  the listeners are bound to that element, so they rebind when it comes back. */
export function useReaderPick(wrapRef: RefObject<HTMLDivElement | null>, sessionId: string, shown: boolean): { chrome: ReactNode } {
  const [menu, setMenu] = useState<(MenuAt & { el: HTMLElement | null }) | null>(null);
  const [picking, setPicking] = useState(false);
  const [picks, setPicks] = useState<Pick[]>([]);
  const pickingRef = useRef(false);
  pickingRef.current = picking;

  const clear = useCallback((ps: readonly Pick[]) => { for (const p of ps) delete p.el.dataset[MARK]; }, []);
  const stop = useCallback(() => { setPicking(false); setPicks((ps) => { clear(ps); return []; }); }, [clear]);
  const closeMenu = useCallback(() => setMenu(null), []);

  // Another session, or the reader going away: its blocks are not on screen.
  useEffect(() => { setMenu(null); stop(); }, [sessionId, shown, stop]);

  // Long-press to open the menu (not while picking — a tap already picks).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    return bindLongPress(el, (x, y, target) => {
      if (pickingRef.current) return;
      const block = target instanceof Element ? target.closest<HTMLElement>(BLOCKS) : null;
      setMenu({ x, y, el: block });
    });
  }, [wrapRef, shown]);

  // In pick mode a tap on a block toggles it, and does nothing else.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !picking) return;
    const onClick = (e: MouseEvent) => {
      const block = e.target instanceof Element ? e.target.closest<HTMLElement>(BLOCKS) : null;
      if (!block || !el.contains(block)) return;
      e.preventDefault();
      e.stopPropagation();
      setPicks((ps) => {
        if (ps.some((p) => p.el === block)) { delete block.dataset[MARK]; return ps.filter((p) => p.el !== block); }
        block.dataset[MARK] = "1";
        return [...ps, { el: block, text: blockText(block) }];
      });
    };
    el.addEventListener("click", onClick, true);
    el.classList.add("tpick-reading");
    return () => { el.removeEventListener("click", onClick, true); el.classList.remove("tpick-reading"); };
  }, [wrapRef, picking, shown]);

  const startPicking = (block: HTMLElement | null) => {
    track("action:readpick.start");
    window.getSelection()?.removeAllRanges();
    setMenu(null);
    if (block) block.dataset[MARK] = "1";
    setPicks(block ? [{ el: block, text: blockText(block) }] : []);
    setPicking(true);
  };

  /** Document order for the blocks still on screen, then the gone ones. */
  const lines = (): string[] => {
    const live = picks.filter((p) => p.el.isConnected)
      .sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    return [...live, ...picks.filter((p) => !p.el.isConnected)].map((p) => p.text);
  };
  const off = picks.filter((p) => !p.el.isConnected).length;

  return {
    chrome: <>
      {menu && <PickMenu at={menu} onPick={() => startPicking(menu.el)} onCancel={closeMenu} />}
      {picking && <PickBar count={picks.length} off={off} hint="tap paragraphs or list items to pick them" lines={lines} onStop={stop} />}
    </>,
  };
}
