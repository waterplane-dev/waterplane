/**
 * One backend's own ledger (`GET /api/tokenstats/<backendId>`), in the backend's
 * own kinds and unit — the generic tab beside Claude Code's and the contributed ones.
 *
 * Drawn in Claude Code's tab's grammar, from its own pieces, so a second ledger reads
 * like the first: the account's quota first when the source has a reading
 * (`SourceWindows`, as `LimitWindows` leads Claude's), then the hero with its split,
 * the sheet's `chart · values` switch, the same `DayChart` columns per day (tokens,
 * then the billing unit) with the 7-day mean, and the models as split bars. `values`
 * prints every figure the charts draw as rows.
 *
 * Money only where the host priced it (`doc.cost`: the list, the person's
 * `prices.json`, or a loopback model's catalogue zero), one total per currency,
 * and every unpriced model as the sentence that says how to add a price. No
 * summed row with another ledger, and no total without its split: the hero is
 * always followed by the kind rows it is made of. A ledger the host cannot read
 * is a SENTENCE, never a zero.
 */
import { useMemo } from "react";
import { fmtCount, fmtExact, fmtMoney, type UsageReading } from "@waterplane/shared";
import { ledgers } from "@waterplane/sdk";
import { Empty, fillSeries, rollingMean, useBoxWidth, useRemoteResource, Button } from "@waterplane/kit";
import {
  type AvailableLedger, costLines, kindRows, kindsTotal, ledgerAbsent, ledgerHero, dayWords, modelRows, recentDays, scopeWords,
  tokenDayPoints, turnsWords, unitDayPoints, unitHero,
} from "./backendLedger.ts";
import { KindBars, NumRow } from "./LedgerParts.tsx";
import { DayChart } from "./charts/DayChart.tsx";
import { SourceWindows } from "./SourceWindows.tsx";
import { TREND_DAYS } from "./constants.ts";

const kindSubs = (kinds: Record<string, number>) => kindRows(kinds).map((r) => `${r.kind} ${fmtCount(r.n)}`);

/** Gap-filled (a day the ledger kept nothing is a measured zero) where the span allows, with the 7-day mean over it. */
function daySeries(pts: { t: number; v: number; day: string }[]) {
  const filled = fillSeries(pts) ?? pts;
  return { pts: filled, trend: filled.length > TREND_DAYS ? rollingMean(filled, TREND_DAYS) : [] };
}

export function BackendLedgerView({ id, label, online, fresh, reading = null, table = false, onTable }: {
  id: string; label: string; online: boolean; fresh: number;
  /** This backend's account reading (its quota), led with when there is one. */
  reading?: UsageReading | null;
  /** The sheet's one chart/values switch. */
  table?: boolean;
  onTable?: (v: boolean) => void;
}) {
  const res = useRemoteResource(
    `backendtokens:${id}:${fresh}`,
    () => ledgers.backendTokens(id, fresh > 0),
    { offline: !online },
  );
  const [width, boxRef] = useBoxWidth();
  const doc = res.data;
  const absent = ledgerAbsent(label, doc);
  const ok: AvailableLedger | null = doc && doc.available === true && !absent ? doc : null;
  const hero = ok ? ledgerHero(ok) : null;
  const unit = ok ? unitHero(ok) : null;
  const money = ok ? costLines(ok, fmtMoney) : null;
  const tokens = useMemo(() => (ok ? daySeries(tokenDayPoints(ok)) : null), [ok]);
  const units = useMemo(() => (unit ? daySeries(unitDayPoints(unit.days)) : null), [unit]);
  const models = ok ? modelRows(ok) : [];
  const trendNote = (n: number) => (n > TREND_DAYS ? ` Dashed: the ${TREND_DAYS}-day mean.` : "");
  return (
    <div className="list ts-list" ref={boxRef}>
      {reading && <SourceWindows reading={reading} online={online} ledger />}
      <Empty res={res} empty={!doc} thing={`${label}’s token statistics`} noun="scan">
        {null}
      </Empty>
      {absent && <div className="empty ts-caveat">{absent}</div>}
      {ok && (
        <>
          <div className="empty ts-caveat">{scopeWords(label, ok, unit?.name)}</div>
          {hero && (
            <>
              <div className="ts-hero-wrap">
                <div className="ts-hero" title={`${fmtExact(hero.total)} tokens`}>{fmtCount(hero.total)}</div>
                <div className="ts-hero-sub">tokens {turnsWords(ok, hero.turns)} — of which:</div>
              </div>
              <KindBars rows={hero.rows} />
            </>
          )}

          {/* The sheet's own switch, directly above the first thing it changes. */}
          {onTable && (hero || unit) && (
            <div className="ts-filter" role="group" aria-label="show as">
              <span className="ctx-stackpick-lab">show as</span>
              <Button className={!table ? "active" : undefined} onClick={() => onTable(false)}>chart</Button>
              <Button className={table ? "active" : undefined} onClick={() => onTable(true)}>values</Button>
            </div>
          )}

          {hero && tokens && tokens.pts.length > 0 && (
            <>
              <div className="section section-head"><span>Tokens per day <span className="section-hint">· {table ? "newest first" : "all days kept"}</span></span></div>
              {table
                ? [...recentDays(ok)].reverse().map((d) => (
                  <NumRow key={d.day} label={d.day} value={d.rows.length ? fmtCount(d.total) : "—"}
                    subs={[
                      d.rows.length ? `${d.turns.toLocaleString()} turns` : dayWords(d, fmtCount),
                      ...d.rows.map((r) => `${r.kind} ${fmtCount(r.n)}`),
                      ...(d.byModel && d.byModel.length > 1 ? d.byModel.map((m) => `${m.key} ${fmtCount(m.total)}`) : []),
                      ...(d.byModel && d.byModel.length === 1 ? [`all ${d.byModel[0].key}`] : []),
                    ]} />
                ))
                : width > 0 && (
                  <>
                    <DayChart pts={tokens.pts} width={width} kind="columns" trend={tokens.trend} label={`${label} tokens per day`} />
                    <div className="empty ts-foot">Every token kind summed per day.{trendNote(tokens.pts.length)}</div>
                  </>
                )}
            </>
          )}

          {unit && units && (
            <>
              <div className="section section-head"><span>{unit.name} <span className="section-hint">· all time</span></span></div>
              <div className="ts-hero-wrap">
                <div className="ts-hero">{fmtCount(unit.total)}</div>
                <div className="ts-hero-sub">{unit.name}. This is the unit {label} is billed in; it is not tokens.</div>
              </div>
              {table
                ? unit.days.slice(-14).reverse().map((d) => (
                  <NumRow key={d.day} label={d.day} value={fmtCount(d.n)} subs={[unit.name]} />
                ))
                : width > 0 && (
                  <>
                    <DayChart pts={units.pts} width={width} kind="columns" trend={units.trend} label={`${unit.name} per day`} />
                    <div className="empty ts-foot">{unit.name} per day.{trendNote(units.pts.length)}</div>
                  </>
                )}
            </>
          )}

          {money && (
            <>
              <div className="section section-head"><span>Cost <span className="section-hint">· by model</span></span></div>
              {money.totals.length > 0 && (
                <div className="empty ts-caveat">
                  <b>{money.totals.join(" · ")}</b> for the priced models{money.totals.length > 1 ? " — one figure per currency, never converted" : ""}
                  {money.lines.some((l) => !l.priced) ? "; the unpriced ones below are not in it" : ""}.
                </div>
              )}
              {money.lines.map((l) => (
                <NumRow key={l.key} label={l.key} value="" subs={[l.text]} />
              ))}
              {money.problems.map((p) => <div key={p} className="empty ts-caveat">Refused in {money.pricesFile}: {p}</div>)}
            </>
          )}

          {ok.models.length > 0 && (
            <>
              <div className="section section-head"><span>By model <span className="section-hint">· tokens, all time</span></span></div>
              {table || models.length === 0
                ? ok.models.map((m) => (
                  <NumRow key={m.key} label={m.label} title={m.key} value={fmtCount(kindsTotal(m.kinds))}
                    subs={[`${m.turns.toLocaleString()} turns`, ...kindSubs(m.kinds)]} />
                ))
                : <KindBars rows={models} />}
            </>
          )}
          {ok.scannedAt > 0 && <div className="empty ts-foot">Read at {new Date(ok.scannedAt).toLocaleTimeString()}.</div>}
        </>
      )}
    </div>
  );
}
