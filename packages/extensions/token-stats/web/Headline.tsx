/**
 * The top of the Claude view: the last seven days as one number, what it is made
 * of, what each part came to at list prices, and a column per day. The numbers
 * are `headline.ts`'s; this file only paints them.
 *
 * It sits ABOVE the live windows and every switch on the screen, so it obeys
 * none of them — it always counts tokens AND money and always spans the same
 * seven calendar days, and its caption says so. A figure that changed under a
 * switch drawn below it would break "a filter is the head of the box it filters".
 */
import { CircleHelp } from "lucide-react";
import { DOLLARS_WHY, DOLLARS_WHY_HEAD, TOKEN_KINDS, fmtCount, fmtExact, fmtUsd, type TokenStatsDoc } from "@waterplane/shared";
import { KindBar, SLOT } from "@waterplane/kit";
import { headline, headlineSpanWords } from "./headline.ts";

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function Headline({ doc, now = Date.now() }: { doc: TokenStatsDoc; now?: number }) {
  const h = headline(doc.days, now);
  if (!h) return null;
  const top = h.peak > 0 ? h.peak : 1;
  return (
    <section className="ts-headline" aria-label="the last 7 days">
      <div className="ts-headline-lab">Last 7 days</div>
      {h.total > 0 ? (
        <>
          <div className="ts-headline-row">
            <div>
              <div className="ts-headline-n" title={`${fmtExact(h.total)} tokens`}>{fmtCount(h.total)}</div>
              <div className="ts-headline-sub">
                tokens · <b>{fmtUsd(h.cost.total)}</b> at list prices · {h.split.turns.toLocaleString()} requests
              </div>
            </div>
            {/* One column per day, the busiest at full height. Not an axis:
                the figure under the busiest names the scale, and today is the
                last column in the accent. A day before the record is an
                outline, never a zero. */}
            <div className="ts-headline-spark" role="img"
              aria-label={`tokens per day: ${h.days.map((d) => `${WD[new Date(d.t).getDay()]} ${d.tok == null ? "not on record" : fmtCount(d.tok)}`).join(", ")}`}>
              <div className="ts-headline-cols">
                {h.days.map((d, i) => (
                  <span key={d.day} className={`ts-headline-col${d.tok == null ? " none" : ""}${i === h.days.length - 1 ? " today" : ""}`}
                    style={{ height: d.tok == null ? "100%" : `${Math.max(d.tok > 0 ? 6 : 2, (d.tok / top) * 100)}%` }} />
                ))}
              </div>
              <div className="ts-headline-days">
                {h.days.map((d) => <span key={d.day}>{WD[new Date(d.t).getDay()][0]}</span>)}
              </div>
            </div>
          </div>
          {/* The split, in the shared strip — the same four hues as every other
              token total in the app — then each kind's money, because a cache
              read and a cache write differ up to 20× in price. */}
          {/* The strip's own legend is hidden here (CSS) because the table
              under it carries the same names and shares WITH the money. */}
          <KindBar bag={h.split} whole={h.total} />
          <table className="ts-headline-split">
            <thead>
              <tr><th scope="col">kind</th><th scope="col">tokens</th><th scope="col">share</th><th scope="col">at list prices</th></tr>
            </thead>
            <tbody>
              {TOKEN_KINDS.map((k) => {
                const v = h.split[k.id];
                const share = (v / h.total) * 100;
                return (
                  <tr key={k.id}>
                    <th scope="row"><i style={{ background: SLOT[k.slot] }} />{k.name}</th>
                    <td title={`${fmtExact(v)} tokens`}>{fmtCount(v)}</td>
                    <td>{share < 0.1 ? "<0.1%" : `${share.toFixed(share < 10 ? 1 : 0)}%`}</td>
                    <td><b>{fmtUsd(h.cost[k.id as "input" | "output" | "cacheRead" | "cacheWrite"])}</b></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="ts-headline-cap">
            Over {headlineSpanWords(h)}, {h.active} of them with work in them · busiest day {fmtCount(h.peak)}.
            {" "}Money is what the API would charge for these tokens at today’s list prices, not your bill.
          </div>
          {/* The first dollar figure on the screen is above, so the question it raises is answered
              here, in words (shared wording, never a copy): a Max plan pays no per-token price. */}
          <details className="hint-more ts-dollars-why">
            <summary><CircleHelp size={12} aria-hidden /> {DOLLARS_WHY_HEAD}</summary>
            <p>{DOLLARS_WHY}</p>
          </details>
        </>
      ) : (
        <div className="ts-headline-cap">Nothing ran in {headlineSpanWords(h)} — the history below goes further back.</div>
      )}
    </section>
  );
}
