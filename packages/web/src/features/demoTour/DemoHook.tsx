/**
 * The demo's first minute, on the session screen (docs/analysis/demo-pitch-plan.md §1):
 *
 *  - `DemoHookHint` — ONE non-modal hint, "Read it like a chat", pointing at the
 *    session's REAL reader toggle (`[data-hint="term.read"]`, `TermArea.tsx`). It
 *    owns no button that switches views: the person taps the toggle itself, and
 *    the hint is gone once the reader has been opened (or its X is tapped).
 *  - `DemoHookCard` — the closing card once the annotate-and-send-back loop has
 *    run: "While you're away", three doors (the schedule sheet, the token
 *    ledger, repo health) and "More to try" (the tour sheet).
 *
 * Both are drawn only in the hook scenario on its session (`logic.ts`
 * `hintShown`/`cardShown`, pure and tested) and send nothing anywhere.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BookOpen, CalendarClock, ChevronRight, Coins, HeartPulse, Sparkles, X } from "lucide-react";
import type { SessionInfo } from "@waterplane/shared";
import { core } from "../../sdk";
import { demoActiveId, isDemo, openRepoHealthFor } from "../../demoEntry";
import { cardShown, hintShown } from "./logic";
import { closeHookCard, hookDoor, hookReadUsed, openDemoTourSheet } from "./actions";
import { useTour } from "./store";

/** The toggle the hint points at — `TermArea`'s reader switch. */
const TOGGLE = '[data-hint="term.read"]';

/** How long the screen is left alone before the hint arrives (the first tool line streams at ~1.2 s). */
const HINT_DELAY_MS = 3_500;

interface Spot { top: number; right: number; arrow: number }

export function DemoHookHint({ sessionId, readMode }: { sessionId: string; readMode: boolean }) {
  const tour = useTour();
  const due = hintShown(tour, { demo: isDemo(), scenario: demoActiveId(), activeId: sessionId });
  // The session opens on claude's own welcome header; the hint comes in once the person has had a look at
  // it and the first tool line has streamed, so it never sits on the logo.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (!due) return undefined;
    const t = window.setTimeout(() => setWaited(true), HINT_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [due]);
  const shown = due && waited;
  const ref = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<Spot | null>(null);

  // Used: the reader is up. The hint has done its one job.
  useEffect(() => { if (shown && readMode) hookReadUsed(); }, [shown, readMode]);

  // Under the toggle, its arrow on the toggle's centre; the toggle pulses while
  // the hint stands (a class on the real button — nothing is drawn over it).
  useLayoutEffect(() => {
    if (!shown || readMode) { setSpot(null); return undefined; }
    const wrap = ref.current?.parentElement;
    const btn = wrap?.querySelector<HTMLElement>(TOGGLE) ?? null;
    if (!wrap || !btn) { setSpot(null); return undefined; }
    const place = () => {
      const w = wrap.getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      const right = 8;
      setSpot({ top: b.bottom - w.top + 8, right, arrow: Math.max(10, w.right - right - (b.left + b.width / 2) - 6) });
    };
    place();
    btn.classList.add("demo-hook-pulse");
    window.addEventListener("resize", place);
    return () => { btn.classList.remove("demo-hook-pulse"); window.removeEventListener("resize", place); };
  }, [shown, readMode]);

  if (!shown || readMode) return null;
  return (
    <div ref={ref} className="demo-hook-hint" role="note" aria-label="Read it like a chat"
      style={spot ? { top: spot.top, right: spot.right } : { visibility: "hidden" }}>
      {spot && <span className="demo-hook-arrow" style={{ right: spot.arrow }} />}
      <BookOpen size={16} className="demo-hook-hint-icon" />
      <span className="demo-hook-hint-text">
        <b>Read it like a chat</b>
        <span>The same session as a transcript — tap the book above. Tap it again to come back.</span>
      </span>
      <button className="demo-hook-x" aria-label="dismiss the hint" onClick={hookReadUsed}><X size={14} /></button>
    </div>
  );
}

export function DemoHookCard({ session, readMode }: { session: SessionInfo; readMode: boolean }) {
  const tour = useTour();
  // Not over the reader: there the newest turn's cost foot is the thing to read, and the
  // card would take the rows it stands in. Back in the terminal it is there again.
  if (readMode || !cardShown(tour, { demo: isDemo(), scenario: demoActiveId(), session })) return null;
  const c = core();
  const repo = c.world.activeRepo;
  const tiles = [
    { id: "schedule" as const, Icon: CalendarClock, head: "Schedule against your week", sub: "Prompts on a clock, run while you are away.", go: () => c.nav.open("schedule") },
    { id: "tokens" as const, Icon: Coins, head: "What it cost", sub: "Every token this desktop spent, with its split.", go: () => c.nav.open("tokens") },
    // Repo health is per repo: the session's own. Without one the tile is not drawn.
    ...(repo ? [{ id: "health" as const, Icon: HeartPulse, head: "Repo health", sub: "How the code is trending, read off the repo.", go: () => openRepoHealthFor(repo.id) }] : []),
  ];
  return (
    <section className="demo-hook-card" aria-label="While you're away">
      <div className="demo-hook-card-head">
        <b>While you’re away</b>
        <button className="key demo-hook-more" onClick={() => hookDoor("more", openDemoTourSheet)}>
          <Sparkles size={12} /> More to try
        </button>
        <button className="demo-hook-x" aria-label="close the card" onClick={closeHookCard}><X size={14} /></button>
      </div>
      <div className="demo-hook-tiles">
        {tiles.map(({ id, Icon, head, sub, go }) => (
          <button key={id} className="demo-hook-tile" onClick={() => hookDoor(id, go)}>
            <Icon size={18} />
            <span className="demo-hook-tile-head">{head}</span>
            <span className="demo-hook-tile-sub">{sub}</span>
            <ChevronRight size={12} className="demo-hook-tile-go" />
          </button>
        ))}
      </div>
    </section>
  );
}
