/**
 * The launcher's top (bar + the strips under it) as a frame a person can
 * shorten, once it runs past one line (the owner's ask, 2026-11-05: a queue
 * strip's second line pushed the repos down).
 *
 * One line has nothing to shorten, so no grip. The first line is the floor: it
 * holds the menu, the bell and settings, and a frame cut below it would hide
 * the way to everything else. The open ☰ menu lifts the cap, as the session
 * header's does, and takes the grip with it.
 *
 * What a cap cuts here can be a banner that arrives later, so a shortened grip
 * says so in words rather than with a chevron alone.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronsDown } from "lucide-react";
import { LS } from "../../storage";
import { useDragCap } from "../session/useDragCap";

/** Less than a strip, more than rounding and the bar's own border. */
const SECOND_LINE_SLOP_PX = 4;
/** Items of one flex line differ by their centring, by far less than a line. */
const SAME_LINE_PX = 20;

/** Where the top bar's first line ends, from the top of `box`. */
function firstLineEnd(box: HTMLElement): number {
  const bar = box.querySelector<HTMLElement>(".topbar");
  if (!bar) return 0;
  const rects = [...bar.children].map((el) => el.getBoundingClientRect()).filter((r) => r.height > 0);
  if (!rects.length) return 0;
  const top = Math.min(...rects.map((r) => r.top));
  const bottom = Math.max(...rects.filter((r) => r.top < top + SAME_LINE_PX).map((r) => r.bottom));
  const css = getComputedStyle(bar);
  return Math.ceil(bottom - box.getBoundingClientRect().top + parseFloat(css.paddingBottom) + parseFloat(css.borderBottomWidth));
}

export function LauncherChrome({ off, children }: { off: boolean; children: ReactNode }): ReactNode {
  const inner = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ natural: 0, line: 0 });
  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    const read = () => {
      const natural = Math.ceil(el.getBoundingClientRect().height);
      const line = firstLineEnd(el);
      setSize((s) => (s.natural === natural && s.line === line ? s : { natural, line }));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { frame, cap, capped, cut, grip } = useDragCap({
    key: LS.launcherChromeH, off, floorPx: size.line,
    showAllEvent: "action:launcherChrome.showAll", capEvent: "action:launcherChrome.cap",
  });
  const words = cut
    ? "top shortened — tap to show all of it, or drag down for more"
    : "drag up to hide what is under the first line";
  const twoLines = size.natural > size.line + SECOND_LINE_SLOP_PX;
  return (
    <>
      <div ref={frame} className={`sess-chrome${capped ? " capped" : ""}`}
        style={capped ? { maxHeight: `${Math.max(cap ?? 0, size.line)}px` } : undefined}>
        <div ref={inner}>{children}</div>
      </div>
      {!off && (twoLines || cut) && (
        <div className={`sess-chrome-grip${cut ? " capped worded" : ""}`}
          role="separator" aria-orientation="horizontal" tabIndex={0}
          aria-label={words} title={words} {...grip}>
          {cut && <><ChevronsDown size={12} aria-hidden="true" /><span>shortened · tap for all of it</span></>}
        </div>
      )}
    </>
  );
}
