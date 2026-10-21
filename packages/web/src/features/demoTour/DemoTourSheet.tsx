/**
 * The `demotour` overlay: "More to try" — the headline features of the app,
 * grouped, one sentence each, every row a tap into that screen of the demo.
 * A row reached by tap says so (a check AND the word), and the head counts
 * them, so a person can see how much of the app they have seen.
 */
import {
  Activity, BellRing, BookOpen, Check, ChevronRight, Clock, Coins, Gauge, Gavel, Hourglass, Images, ListTodo,
  HeartPulse, MousePointerClick, Search, Send, Sparkles, Terminal, type LucideIcon,
} from "lucide-react";
import { Sheet } from "../../Sheet";
import { TOUR, progressText, type TourIcon } from "./logic";
import { closeDemoTour, runTourRow } from "./actions";
import { useTour } from "./store";
import { Button } from "../../kit";

const ICONS: Record<TourIcon, LucideIcon> = {
  terminal: Terminal, pointer: MousePointerClick, book: BookOpen, list: ListTodo, clock: Clock,
  hourglass: Hourglass, activity: Activity, images: Images, bell: BellRing, send: Send, search: Search,
  gavel: Gavel, coins: Coins, gauge: Gauge, heart: HeartPulse,
};

const ICON = 20;

export function DemoTourSheet() {
  const tour = useTour();
  const seen = new Set(tour.seen);
  return (
    <Sheet
      title="More to try"
      icon={<Sparkles size={18} />}
      onClose={closeDemoTour}
      className="tour"
      footer={<Button className="tour-done" onClick={closeDemoTour}>Look around on my own</Button>}
    >
      <div className="sheet-body tour-body">
        <p className="tour-intro">
          A pretend desktop with three sample repos. Tap a row to open that screen — Back brings you here.
          <span className="tour-progress"> {progressText(tour)}.</span>
        </p>
        {TOUR.map((g) => (
          <section key={g.title} className="tour-group" aria-label={g.title}>
            <h3 className="tour-group-title">{g.title}</h3>
            {g.rows.map((r) => {
              const Icon = ICONS[r.icon];
              const done = seen.has(r.id);
              return (
                <button key={r.id} className={done ? "tour-row seen" : "tour-row"} onClick={() => runTourRow(r)}>
                  <span className="tour-icon"><Icon size={ICON} /></span>
                  <span className="tour-text">
                    <span className="tour-head">
                      {r.headline}
                      {done ? <span className="tour-seen"><Check size={13} /> tried</span> : null}
                    </span>
                    <span className="tour-sentence">{r.sentence}</span>
                  </span>
                  <ChevronRight className="tour-go" size={18} />
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </Sheet>
  );
}
