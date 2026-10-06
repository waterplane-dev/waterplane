/**
 * One backend's own ledger (`GET /api/tokenstats/<backendId>`), in the backend's
 * own kinds and unit — the generic tab beside Claude Code's and the contributed ones.
 *
 * Money only where the host priced it (`doc.cost`: the list, the person's
 * `prices.json`, or a loopback model's catalogue zero), one total per currency,
 * and every unpriced model as the sentence that says how to add a price. No
 * summed row with another ledger, and no total without its split: the hero is
 * always followed by the kind rows it is made of. A ledger the host cannot read
 * is a SENTENCE, never a zero.
 */
import { fmtCount, fmtExact, fmtMoney } from "@waterplane/shared";
import { ledgers } from "@waterplane/sdk";
import { Empty, useRemoteResource } from "@waterplane/kit";
import {
  type AvailableLedger, costLines, kindRows, kindsTotal, ledgerAbsent, ledgerHero, dayWords, recentDays, scopeWords, turnsWords, unitHero,
} from "./backendLedger.ts";
import { KindBars, NumRow } from "./LedgerParts.tsx";

const kindSubs = (kinds: Record<string, number>) => kindRows(kinds).map((r) => `${r.kind} ${fmtCount(r.n)}`);

export function BackendLedgerView({ id, label, online, fresh }: { id: string; label: string; online: boolean; fresh: number }) {
  const res = useRemoteResource(
    `backendtokens:${id}:${fresh}`,
    () => ledgers.backendTokens(id, fresh > 0),
    { offline: !online },
  );
  const doc = res.data;
  const absent = ledgerAbsent(label, doc);
  const ok: AvailableLedger | null = doc && doc.available === true && !absent ? doc : null;
  const hero = ok ? ledgerHero(ok) : null;
  const unit = ok ? unitHero(ok) : null;
  const money = ok ? costLines(ok, fmtMoney) : null;
  return (
    <div className="list ts-list">
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
              <KindBars rows={kindRows(ok.totals.kinds)} />
            </>
          )}
          {unit && (
            <>
              <div className="section section-head"><span>{unit.name} <span className="section-hint">· all time</span></span></div>
              <div className="ts-hero-wrap">
                <div className="ts-hero">{fmtCount(unit.total)}</div>
                <div className="ts-hero-sub">{unit.name}. This is the unit {label} is billed in; it is not tokens.</div>
              </div>
              {unit.days.slice(-14).reverse().map((d) => (
                <NumRow key={d.day} label={d.day} value={fmtCount(d.n)} subs={[unit.name]} />
              ))}
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
              <div className="section section-head"><span>By model</span></div>
              {ok.models.map((m) => (
                <NumRow key={m.key} label={m.label} title={m.key} value={fmtCount(kindsTotal(m.kinds))}
                  subs={[`${m.turns.toLocaleString()} turns`, ...kindSubs(m.kinds)]} />
              ))}
            </>
          )}
          {recentDays(ok).length > 0 && (
            <>
              <div className="section section-head"><span>Last days <span className="section-hint">· newest first</span></span></div>
              {[...recentDays(ok)].reverse().map((d) => (
                <NumRow key={d.day} label={d.day} value={d.rows.length ? fmtCount(d.total) : "—"}
                  subs={[
                    d.rows.length ? `${d.turns.toLocaleString()} turns` : dayWords(d, fmtCount),
                    ...d.rows.map((r) => `${r.kind} ${fmtCount(r.n)}`),
                    ...(d.byModel && d.byModel.length > 1 ? d.byModel.map((m) => `${m.key} ${fmtCount(m.total)}`) : []),
                    ...(d.byModel && d.byModel.length === 1 ? [`all ${d.byModel[0].key}`] : []),
                  ]} />
              ))}
            </>
          )}
          {ok.scannedAt > 0 && <div className="empty ts-foot">Read at {new Date(ok.scannedAt).toLocaleTimeString()}.</div>}
        </>
      )}
    </div>
  );
}
