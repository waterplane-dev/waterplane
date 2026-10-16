/**
 * The schedule sheet's week bar: the next seven days, the two usage windows on
 * them, and a numbered pin wherever a rule fires next. Geometry and every edge
 * are `scheduleWeekPlot.ts`'s (which reads the host's `nextAt` and the one usage
 * reading — no second copy of a reset); this file paints them.
 *
 * Read-only. Nothing here is a control: the pins are pictures, the list under
 * them says the same thing in words, and every verb stays on the cards below.
 */
import { CalendarClock, Gauge } from "lucide-react";
import type { ScheduleEntry, WindowResets } from "@waterplane/shared";
import { fmtWhen, inWords } from "./sendIntent";
import { Explain } from "./Explain";
import { anchorWords, weekBar, type BarWindow } from "./scheduleWeekPlot";

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pct = (x: number) => `${(Math.min(1, Math.max(0, x)) * 100).toFixed(2)}%`;

function Lane({ w, name, cls }: { w: BarWindow | null; name: string; cls: string }) {
  if (!w) return null;
  return (
    <div className={`swb-lane ${cls}`}>
      <div className="swb-lane-lab">
        <b>{name}</b>{w.pct != null ? <> · {Math.round(w.pct)}% used</> : null} · resets {fmtWhen(w.resetAt)}
      </div>
      <div className="swb-track">
        {/* The rest of the window that is open now, from here to its reset. */}
        <span className="swb-fill" style={{ width: pct(w.x) }} />
        <span className="swb-reset" style={{ left: pct(w.x) }} />
      </div>
    </div>
  );
}

export function ScheduleWeekBar({ entries, usage, title, now = Date.now() }: {
  entries: readonly ScheduleEntry[];
  usage: WindowResets | null | undefined;
  /** The card's name for a rule — the sheet's own `typedName`-or-prose rule. */
  title: (e: ScheduleEntry) => string;
  now?: number;
}) {
  const bar = weekBar(entries, usage, now);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const read = bar.session || bar.weekly;
  if (!read && bar.fires.length === 0) return null;
  const PIN_ROW = 22;
  return (
    <section className="swb" aria-label="the next seven days against your usage windows">
      <div className="swb-title"><Gauge size={13} /> The next 7 days against your usage windows</div>
      <Lane w={bar.weekly} name="Weekly window" cls="weekly" />
      <Lane w={bar.session} name="Session window" cls="session" />
      <div className="swb-pins" style={{ height: bar.lanes * PIN_ROW + 4 }}>
        {/* The resets carry down through the pins, so a rule anchored to one
            visibly sits on (or just before) its line. */}
        {bar.weekly && <span className="swb-rule weekly" style={{ left: pct(bar.weekly.x) }} />}
        {bar.session && <span className="swb-rule session" style={{ left: pct(bar.session.x) }} />}
        {bar.fires.map((f) => (
          <span key={f.id} className={`swb-pin${f.anchor ? " anchored" : ""}`}
            style={{ left: pct(f.x), top: f.lane * PIN_ROW + 2 }} aria-hidden>{f.n}</span>
        ))}
      </div>
      <div className="swb-days" aria-hidden>
        <span className="swb-day" style={{ left: 0 }}>now</span>
        {/* A midnight too close to "now" would print over it; its column is
            still there, only the label goes. */}
        {bar.days.filter((d) => d.x >= 0.09).map((d) => (
          <span key={d.t} className="swb-day" style={{ left: pct(d.x) }}>{WD[new Date(d.t).getDay()]}</span>
        ))}
      </div>
      {bar.fires.length > 0 && (
        <ol className="swb-list">
          {bar.fires.map((f) => {
            const e = byId.get(f.id);
            return (
              <li key={f.id}>
                <span className={`swb-pin inline${f.anchor ? " anchored" : ""}`}>{f.n}</span>
                <span className="swb-list-txt">
                  <b>{e ? title(e) : f.id}</b> · {fmtWhen(f.at)} ({inWords(f.at, now)}) · {anchorWords(f, bar)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {/* What the bar does not draw, said rather than left blank. */}
      {!read && (
        <div className="swb-note">
          The desktop has not read your usage windows yet, so only clock rules are drawn. A rule anchored to a window
          arms the first time it does.
        </div>
      )}
      {bar.unread.length > 0 && read && (
        <div className="swb-note">
          {bar.unread.length === 1 ? "One window rule is" : `${bar.unread.length} window rules are`} not armed —
          the window it tracks has not been read yet.
        </div>
      )}
      {bar.later.length > 0 && (
        <div className="swb-note">
          <CalendarClock size={12} style={{ verticalAlign: "-2px" }} /> Further out:{" "}
          {bar.later.map((l, i) => {
            const e = byId.get(l.id);
            return <span key={l.id}>{i ? "; " : ""}{e ? title(e) : l.id} {fmtWhen(l.at)}</span>;
          })}
        </div>
      )}
      {/* The legend, closed. It was a paragraph under every bar, read once and
          then scrolled past on each visit; the words are unchanged, one tap
          away. The notes above stay open: they say what is MISSING from this
          bar, which a legend never does. */}
      {read && (
        <div className="swb-note">
          <Explain of="the week bar" label="how to read it">
            Shaded: the window open now, up to its reset. Filled pins are anchored to a reset, hollow ones to a clock.
            {bar.session ? " Only the session window open now is drawn — the next one starts with the first prompt after its reset, which no clock can place." : ""}
          </Explain>
        </div>
      )}
    </section>
  );
}
