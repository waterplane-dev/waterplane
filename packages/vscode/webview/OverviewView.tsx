/**
 * All sessions: the phone's token-usage screen — `TokenStatsBody` itself, imported from source
 * (`packages/extensions/token-stats/web/`), over the `CorpusDoc` the scan worker folds (the same
 * `TokenStatsDoc` shape). Nothing here derives a figure: every span, cut, chart and sentence is the
 * phone's, so the two screens cannot drift apart. `tools/webshape.test.mjs` holds this file to that.
 *
 * Two sources, never merged:
 * - Claude's ledger is this panel's OWN scan of the logs on this machine — always there.
 * - The live parts (the five-hour and weekly limit windows, the week since its reset, the dollar
 *   period, the past-window grids, the other backends' ledgers) come from a waterplane desktop on
 *   this machine, read over loopback by the extension host (`src/hostlink.ts`), and only once the
 *   person has switched that on. Without it they are ABSENT, and the line above the screen says
 *   why — never a bar with no reading under it.
 *
 * - Copilot Chat's ledger (`CorpusDoc.copilot`) is the same scan's, off VS Code's own chat logs: its
 *   tab is there whenever that ledger counted something, desktop or not, and the screen opens on it
 *   when Claude's logs hold nothing — a machine with Copilot and no Claude. Above it sits Copilot's
 *   plan and this month's local count (no sign-in), and GitHub's own quota behind its one button:
 *   the extension's only network call, off until pressed (`src/copilotquota.ts`).
 *
 * A costliest-conversations row that is one of the active folder's listed sessions keeps the phone's
 * "context & cost" door (`here`); it opens that session in the Session view.
 *
 * What this file adds is only what the panel has and the phone does not: the seven-day headline
 * (`Headline`) and, with no desktop to say where the week since its reset went, the last seven
 * calendar days in the phone's week card, captioned as exactly that.
 */
import { BRAND, fmtCount, tokenTotal, usageWindowPct } from "@waterplane/shared";
import { Button } from "@waterplane/kit";
import { Headline } from "../../extensions/token-stats/web/Headline.tsx";
import { WeekCard } from "../../extensions/token-stats/web/WeekCard.tsx";
import { TokenStatsBody } from "../../extensions/token-stats/web/TokenStatsBody.tsx";
import { ledgerAbsent, ledgerBackends } from "../../extensions/token-stats/web/backendLedger.ts";
import { windowText } from "../../extensions/token-stats/web/sourceWords.ts";
import { COPILOT_LEDGER, type CopilotQuotaView, type CorpusDoc, type LiveState, type ToExtension } from "../src/protocol";
import { Absent } from "./Absent";
import { Loading } from "./Loading";
import { TabLinks } from "./TabLinks";
import { fmtAge } from "../src/data/running";
import { useNow } from "./HealthView";

export function OverviewView({ doc, why, scanning, live, copilot = null, post, askedLedger = null, here = null }: {
  doc: CorpusDoc | null;
  /** Copilot's plan and quota, drawn above the Copilot Chat tab; null before the extension's first read. */
  copilot?: CopilotQuotaView | null;
  /** The active folder's listed sessions: a costliest row that is one of them gets the phone's
   *  "context & cost" door, opening it in the Session view. null = no door anywhere. */
  here?: { folder: string; ids: ReadonlySet<string> } | null;
  /** The ledger tab the tree asked for (the Copilot row's click); null = the screen's own choice. */
  askedLedger?: string | null;
  why?: string;
  scanning?: { done: number; total: number };
  live: LiveState | null;
  post: (m: ToExtension) => void;
}) {
  // The bar sits ABOVE the figures; with a saved scan on screen it says how old those figures are.
  const now = useNow(!!scanning && !!doc, 15_000);
  const progress = scanning
    ? <Loading done={scanning.done} total={scanning.total}>
        Reading logs: {fmtCount(scanning.done)} of {fmtCount(scanning.total)}…{doc ? ` Showing the scan from ${fmtAge(now - doc.scannedAt)}.` : ""}
      </Loading>
    : null;
  if (!doc) return <>{progress ?? (why ? null : <Loading>Reading logs…</Loading>)}{why ? <Absent>{why}</Absent> : null}</>;
  const d = live?.doc ?? null;
  // The tab is there when the scan counted Copilot Chat, or when the plan was found: the quota has
  // nowhere else to be shown.
  const counted = !!doc.copilot && !ledgerAbsent(COPILOT_LEDGER.label, doc.copilot);
  const copilotTab = counted || !!copilot?.local ? [{ ...COPILOT_LEDGER }] : [];
  const claudeEmpty = tokenTotal(doc.totals) === 0;
  const openOn = copilotTab.length && ((claudeEmpty && counted) || askedLedger === COPILOT_LEDGER.id) ? COPILOT_LEDGER.id : null;
  const weekFrom = new Date(doc.week.fromHour).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const lead = <>
    <Headline doc={doc} now={doc.scannedAt} />
    {/* The phone's week card is the week since the LIMIT's reset, which only the desktop knows;
        without it, the last seven calendar days, and the caption says which. */}
    {!d && tokenTotal(doc.week.totals) > 0 && (
      <WeekCard doc={doc.week} res={{ state: "fresh" }} openedAt={doc.week.fromHour} samples={[]} everyMs={0} cal={null} compact
        span={{
          caption: `The headline’s seven days, ${weekFrom} 00:00 to the last scan — calendar days, not your weekly limit’s window: no ${BRAND.name} desktop is read for its reset.`,
          tag: "last 7 days",
        }} />
    )}
  </>;
  return (
    <>
      {progress}
      <DesktopLine live={live} post={post} />
      {/* Keyed on the desktop: the span a screen opens on is the body's initial state, and it
          opens on the week since the reset only when there is a reset to cut at. */}
      <div className="ts-body" key={`${d ? "desktop" : "local"}:${openOn ?? "claude"}`}>
        <TokenStatsBody doc={doc} res={{ state: "fresh" }} online={!!d} liveWindows={!!d}
          usage={d?.usage ?? null}
          spend={d ? { profile: d.billing.profile, budget: d.budget, periods: d.periods } : undefined}
          readings={d?.readings} ledgerTabs={[...copilotTab, ...(d ? ledgerBackends(d.backends) : [])]}
          ledgerLead={(id) => (id === COPILOT_LEDGER.id && copilot ? <CopilotPlan q={copilot} post={post} /> : null)}
          localLedgers={[COPILOT_LEDGER.id]} openedOn={openOn}
          initialSpan={d ? { id: "week", back: 0 } : { id: "30", back: 0 }}
          onRescan={() => post({ t: "rescan" })}
          canOpen={here ? (id) => here.ids.has(id) : undefined}
          onOpenConvo={here ? (id) => { post({ t: "pickSession", folder: here.folder, id }); post({ t: "openPanel", tab: "session" }); } : undefined}
          lead={lead} doors={<TabLinks tabs={["session", "always-on"]} post={post} />} />
      </div>
    </>
  );
}

/** Where the live parts come from, or why they are not here, with the one switch for it. */
function DesktopLine({ live, post }: { live: LiveState | null; post: (m: ToExtension) => void }) {
  if (!live) return null;
  if (live.doc) {
    return (
      <div className="empty ts-caveat ctx-note">
        Limits, budget and other backends from the {BRAND.name} desktop at {live.host}.{" "}
        <Button type="button" onClick={() => post({ t: "desktop", on: false })}>stop reading it</Button>
      </div>
    );
  }
  return (
    <div className="empty ts-caveat ctx-note">
      {live.why}{" "}
      {live.host
        ? <>
          <Button type="button" onClick={() => post({ t: "liveRead" })}>ask again</Button>{" "}
          <Button type="button" onClick={() => post({ t: "desktop", on: false })}>stop reading it</Button>
        </>
        : <Button type="button" onClick={() => post({ t: "desktop", on: true })}>read the desktop on this machine</Button>}
    </div>
  );
}

/**
 * Copilot's plan and this month's requests on this machine (no sign-in), then GitHub's own quota once
 * the person asks for it. The button says what it does before it is pressed: it is the extension's
 * only network call, and VS Code asks once to share the GitHub sign-in.
 */
function CopilotPlan({ q, post }: { q: CopilotQuotaView; post: (m: ToExtension) => void }) {
  const r = q.reading;
  return (
    <div className="ts-lims">
      <div className="section section-head"><span>Copilot plan and quota</span></div>
      {q.local
        ? <div className="ts-lim-sub">{q.local.words}</div>
        : <div className="empty ts-caveat">The plan and this month’s requests are not read yet.</div>}
      {q.local && q.local.lines.length > 1 && (
        <details className="ts-caveat">
          <summary>How this month is counted</summary>
          {q.local.lines.map((l, i) => <div key={i}>{l}</div>)}
        </details>
      )}
      {r && r.windows.map((w) => {
        const pct = usageWindowPct(w);
        if (pct == null) return null;
        const hot = pct >= 80;
        return (
          <div key={w.id} className="ts-lim">
            <div className="ts-barhead">
              <span className="ts-barlabel">{windowText(w)}</span>
              <span className={`ts-barval${hot ? " hot" : ""}`}>{Math.round(pct)}% used</span>
            </div>
            <div className="ts-bartrack"><span className={`ts-barfill${hot ? " hot" : ""}`} style={{ width: `${pct}%` }} /></div>
            {w.resetAt && <div className="ts-lim-sub">Resets {new Date(w.resetAt).toLocaleDateString()}.</div>}
          </div>
        );
      })}
      {r && <div className="empty ts-foot">Read from GitHub at {new Date(r.checkedAt).toLocaleTimeString()}, again every 10 minutes.</div>}
      {q.why && <div className="empty ts-caveat">{q.why}</div>}
      <div className="empty ts-caveat ctx-note">
        {q.on
          ? <>
            <Button type="button" onClick={() => post({ t: "copilotQuota", on: true })}>{q.busy ? "reading GitHub…" : "read GitHub again"}</Button>{" "}
            <Button type="button" onClick={() => post({ t: "copilotQuota", on: false })}>stop reading GitHub</Button>
          </>
          : <>
            Only GitHub knows the limit and reset date.{" "}
            <Button type="button" onClick={() => post({ t: "copilotQuota", on: true })}>read them from GitHub</Button>{" "}
            VS Code asks once to share the GitHub account it is signed in with; this is the extension’s only network call.
          </>}
      </div>
    </div>
  );
}
