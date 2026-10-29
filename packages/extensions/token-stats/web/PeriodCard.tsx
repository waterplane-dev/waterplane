/** "Where the month went": a dollar period's spend on this desktop, by repo and by model, with its pacing. */
import { useMemo, useState } from "react";
import { fmtCount, fmtUsd, rankRepos, tokenTotal, type CostWindowDoc, type PeriodState } from "@waterplane/shared";
import { modelRows, pacingLine, periodTitle, usdWords } from "@waterplane/sdk";
import { ScopeCard, ScopeTag } from "./TokenInsights.tsx";
import { BesideBlock } from "./BesideBlock.tsx";
import { Composition } from "./Readouts.tsx";
import { foldStateText, priced, rowFacts, usdOrTok } from "./weekBands.ts";
import { Button } from "@waterplane/kit";

const ROWS_SHOWN = 8;

interface Row { key: string; label: string; usd: number; tok: number; facts: string }

/**
 * A period's money, for the account that has no weekly window to spend it against.
 *
 * Everything is the local ledger at list price and the caption says so ONCE — not on the hero, not
 * under each row. The total is never printed without its split: the composition strip is the token
 * kinds, and the repo and model rows below each add up to the hero (the host folds the cheapest
 * sessions into `rest`, and `rankRepos`/`modelRows` keep them in their rows). Pacing is
 * `periodWords`' — absent where the cap, the edge or the elapsed time cannot support it.
 * The rows are a reading, not controls: nothing here filters, so nothing carries a count.
 */
export function PeriodCard({ state, cap, doc, res, refusal, now }: {
  state: PeriodState;
  cap: number | null;
  doc: CostWindowDoc | null;
  res: { state: string; error?: string | null };
  /** Why this period cannot be read at all (a span past the host's 35 days), or null. */
  refusal: string | null;
  now: number;
}) {
  const [by, setBy] = useState<"repo" | "model">("repo");
  const [all, setAll] = useState(false);
  const title = periodTitle(state.period);

  const repoRows: Row[] = useMemo(() => (doc ? rankRepos(doc.convos, doc.rest).map((r) => ({
    key: r.repo, label: r.label, usd: r.cost.total, tok: tokenTotal(r.totals), facts: rowFacts(r.convos.length, r.more, tokenTotal(r.totals)),
  })) : []), [doc]);
  const modelList: Row[] = useMemo(() => (doc ? modelRows(doc.convos, doc.rest).map((m) => ({
    key: m.model, label: m.label, usd: m.usd, tok: m.tokens, facts: `${fmtCount(m.tokens)} tokens`,
  })) : []), [doc]);

  if (refusal) {
    return <ScopeCard title={title} chips={null}><div className="empty ts-caveat">{refusal}</div></ScopeCard>;
  }
  if (!doc) {
    return <ScopeCard title={title} chips={null}><div className="empty ts-caveat">{foldStateText(res, "window")}</div></ScopeCard>;
  }

  const total = doc.cost.total;
  const totalTok = tokenTotal(doc.totals);
  const rows = by === "repo" ? repoRows : modelList;
  const shown = all ? rows : rows.slice(0, ROWS_SHOWN);
  // Pacing is judged on the document's own total, so it can never disagree with the hero beside it.
  const words = pacingLine({ ...state, spentUsd: total }, cap, now);
  const sessions = doc.convosTotal ?? doc.convos.length;
  const chips = total > 0 || totalTok > 0 ? <>
    <Button className={by === "repo" ? "active" : undefined} onClick={() => setBy("repo")}>by repo</Button>
    <Button className={by === "model" ? "active" : undefined} onClick={() => setBy("model")}>by model</Button>
  </> : null;

  return (
    <ScopeCard title={title} chips={chips}
      caption={<>This desktop only, at list price — not your invoice. <ScopeTag>{state.resetAt != null ? "this period so far" : "trailing"} · in {priced(total) ? "money" : "tokens"}</ScopeTag></>}>
      <div className="ts-hero-wrap">
        <div className="ts-hero">{priced(total) ? fmtUsd(total) : fmtCount(totalTok)}</div>
        <div className="ts-hero-sub">
          {cap != null && <>of a {usdWords(cap)} cap · </>}
          {words.map((w) => <span key={w}>{w} · </span>)}
          {fmtCount(totalTok)} tokens across {sessions} {sessions === 1 ? "session" : "sessions"}
        </div>
      </div>
      <Composition totals={doc.totals} cost={doc.cost} money={priced(total)} />
      {tokenTotal(doc.unpriced) > 0 && (
        <div className="empty ts-caveat">{fmtCount(tokenTotal(doc.unpriced))} tokens ran on a model with no published rate and are <b>not</b> in this figure.</div>
      )}
      <BesideBlock rows={doc.beside} />
      {!rows.length ? <div className="empty ts-caveat">Nothing has run on this desktop in this period.</div> : <>
        <div className="section section-head">
          <span>{by === "repo" ? "By repo" : "By model"}</span>
        </div>
        <div className="ts-convos">
          {shown.map((r) => {
            const share = priced(total) ? r.usd / total : totalTok > 0 ? r.tok / totalTok : 0;
            return (
              <div className="ts-convo" key={r.key}>
                <div className="ts-barhead">
                  <span className="ts-barlabel">{r.label}</span>
                  <span className="ts-barval">{usdOrTok(r.usd, r.tok)}<em>{share < 0.01 ? "<1" : Math.round(share * 100)}%</em></span>
                </div>
                <div className="ts-bartrack"><span className="ts-barfill" style={{ width: `${Math.max(1, share * 100)}%` }} /></div>
                <div className="ts-convo-facts">{r.facts}</div>
              </div>
            );
          })}
          {rows.length > ROWS_SHOWN && (
            <Button className="ts-convos-more" onClick={() => setAll((v) => !v)}>
              {all ? `show the top ${ROWS_SHOWN}` : `show all ${rows.length}`}
            </Button>
          )}
        </div>
      </>}
    </ScopeCard>
  );
}
