/** One usage source's quota windows: bars, count form, reset, age, and the kept readings on claude's limit chart (`UsageSpark`). */
import { useEffect, useState } from "react";
import { Clock, Gauge } from "lucide-react";
import { usageWindowPct, type UsageReading, type UsageSourceHistoryDoc } from "@waterplane/shared";
import { ledgers } from "@waterplane/sdk";
import { ago, until } from "@waterplane/kit";
import { resetWhen } from "./when.ts";
import { asUsageSamples, sparkPoints, windowText } from "./sourceWords.ts";
import { UsageSpark } from "./UsageSpark.tsx";

/** A quota's history reaches back further than the 5-hour lane's day: Copilot's runs a month. */
const SOURCE_HOURS = 7 * 24;

export function SourceWindows({ reading, online, ledger = false }: { reading: UsageReading | null; online: boolean; ledger?: boolean }) {
  const source = reading?.source ?? null;
  const [doc, setDoc] = useState<UsageSourceHistoryDoc | null>(null);
  useEffect(() => {
    setDoc(null);
    if (!source || !online) return;
    const ac = new AbortController();
    void ledgers.sourceHistory(source, ac.signal).then((d) => { if (!ac.signal.aborted) setDoc(d); });
    return () => ac.abort();
  }, [source, online, reading?.checkedAt]);

  if (!reading) {
    return <div className="empty ts-caveat">This source has no reading right now, so there is nothing to show for it.</div>;
  }
  return (
    <div className="ts-lims">
      <div className="section section-head">
        <span><Gauge size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />{reading.label} quota</span>
      </div>
      {reading.windows.map((w) => {
        const pct = usageWindowPct(w);
        if (pct == null) return null;
        const hot = pct >= 80;
        return (
          <div key={w.id} className="ts-lim">
            <div className="ts-barhead">
              <span className="ts-barlabel">{windowText(w)}</span>
              <span className={`ts-barval${hot ? " hot" : ""}`}>{pct}% used</span>
            </div>
            <div className="ts-bartrack"><span className={`ts-barfill${hot ? " hot" : ""}`} style={{ width: `${pct}%` }} /></div>
            {doc
              ? <UsageSpark samples={asUsageSamples(sparkPoints(doc, w.id))} which="session" reset={w.resetAt ?? null} pct={pct}
                everyMs={0} hours={SOURCE_HOURS} name={`${reading.label} ${w.id}`} />
              : <div className="ts-spark-none">No kept readings could be read from this desktop.</div>}
            <div className="ts-lim-sub">
              {w.resetAt
                ? <><Clock size={11} style={{ verticalAlign: "-1px" }} /> Resets {resetWhen(w.resetAt)} — in {until(w.resetAt)}.</>
                : <>The source did not name a reset time for this window.</>}
            </div>
          </div>
        );
      })}
      <div className="empty ts-foot">
        {reading.remembered
          ? <>Kept from before this desktop’s daemon last restarted, read {ago(reading.checkedAt)} — nothing has re-read {reading.label} since, so this can only have filled further.</>
          : <>Read {ago(reading.checkedAt)}.</>}
        {ledger
          ? <>{" "}The quota is {reading.label}’s account; the figures below are only this desktop’s sessions.</>
          : <>{" "}No token ledger for {reading.label} on this desktop — only its quota is read, so there is no total and no price.</>}
      </div>
    </div>
  );
}
