/**
 * The "Local runner" tab: what ollama itself did, per model — compute time,
 * tokens, memory (`GET /api/localusage`, words in `localRunner.ts`).
 *
 * A third document, never summed with the token ledgers beside it: those count
 * what a CLIENT sent; this counts what the RUNNER did, whichever client asked.
 * The span chips cut the days (not a count, so no number on them); every card
 * prints each total with its split; an absent family is a sentence.
 */
import { useState } from "react";
import type { LocalUsageDoc } from "@waterplane/shared";
import { localUsageNotes } from "@waterplane/shared";
import { Empty, type RemoteResource, Button } from "@waterplane/kit";
import { NumRow } from "./LedgerParts.tsx";
import { RUNNER_SPANS, runnerDayRows, runnerViews, spanFromDay, type RunnerModelView, type RunnerSpan } from "./localRunner.ts";

const fmtTime = (ms: number) => new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtDay = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

/** A total and the parts it is made of, as one table row (`LedgerParts.tsx`). */
function Split({ total, split }: { total: string; split: string[] }) {
  return <NumRow label={total} value="" subs={split} />;
}

function ModelCard({ v, why }: { v: RunnerModelView; why: string }) {
  return (
    <>
      <div className="section section-head"><span>{v.title}</span></div>
      {v.unidentified && <div className="empty ts-caveat">{why}</div>}
      <div className="empty ts-foot">Compute — the runner's own timings</div>
      {v.busy ? <Split total={`busy ${v.busy.total}`} split={v.busy.split} /> : null}
      {v.loads && <div className="empty">{v.loads}</div>}
      {v.answer && <div className="empty">{v.answer}</div>}
      {v.untimed && <div className="empty">{v.untimed}</div>}
      {v.requests && <Split total={v.requests.total} split={v.requests.split} />}
      {v.tokens && (
        <>
          <div className="empty ts-foot">Tokens — the runner's own counts</div>
          <Split total={v.tokens.total} split={v.tokens.split} />
          {v.rates.length > 0 && <div className="empty">Throughput, measured sums: {v.rates.join(" · ")}.</div>}
        </>
      )}
      {v.memory.length > 0 && (
        <>
          <div className="empty ts-foot">Memory — what /api/ps reported</div>
          {v.memory.map((l) => <div key={l} className="empty">{l}</div>)}
          {v.machine.map((l) => <div key={l} className="empty">{l}</div>)}
        </>
      )}
      {v.absent.map((a) => <div key={a} className="empty ts-caveat">{a}</div>)}
    </>
  );
}

export function LocalRunnerView({ res }: { res: RemoteResource<LocalUsageDoc> }) {
  const [span, setSpan] = useState<RunnerSpan>("7");
  const doc = res.data;
  const from = spanFromDay(span, Date.now());
  const ok = doc && doc.available === true ? doc : null;
  const views = ok ? runnerViews(ok.days, from) : [];
  const dayRows = ok ? runnerDayRows(ok.days, from) : [];
  return (
    <div className="list ts-list">
      <Empty res={res} empty={!doc} thing="the local runner's ledger" noun="read">
        {null}
      </Empty>
      {doc && doc.available === false && <div className="empty ts-caveat">{doc.reason}</div>}
      {ok && (
        <>
          <div className="empty ts-caveat">
            What {ok.runner} itself did, per model, read from its server log and /api/ps since {fmtTime(ok.since)} — whichever
            backend asked. Not summed with the token ledgers: those count what a client sent.
            {ok.loaded.length > 0 ? ` Loaded now: ${ok.loaded.join(", ")}.` : ""}
          </div>
          {localUsageNotes(ok, fmtTime).map((n) => <div key={n} className="empty ts-caveat">{n}</div>)}
          <div className="ts-filter">
            <span className="empty">over</span>
            {RUNNER_SPANS.map((s) => (
              <Button key={s.id} className={span === s.id ? "active" : undefined} onClick={() => setSpan(s.id)}>{s.label}</Button>
            ))}
          </div>
          {views.length === 0 && ok.days.length > 0 && <div className="empty ts-caveat">Nothing recorded in this span — a wider one has days.</div>}
          {views.map((v) => <ModelCard key={v.key} v={v} why={ok.unattributedWhy} />)}
          {dayRows.length > 0 && (
            <>
              <div className="section section-head"><span>By day <span className="section-hint">· newest first</span></span></div>
              {dayRows.map((r) => (
                <NumRow key={r.key} label={fmtDay(r.day)} value="" subs={[r.model, r.text]} />
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
