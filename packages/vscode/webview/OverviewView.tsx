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
 *   when Claude's logs hold nothing — a machine with Copilot and no Claude.
 *
 * A costliest-conversations row that is one of the active folder's listed sessions keeps the phone's
 * "context & cost" door (`here`); it opens that session in the Session view.
 *
 * What this file adds is only what the panel has and the phone does not: the seven-day headline
 * (`Headline`) and, with no desktop to say where the week since its reset went, the last seven
 * calendar days in the phone's week card, captioned as exactly that.
 */
import { BRAND, fmtCount, tokenTotal } from "@waterplane/shared";
import { Button } from "@waterplane/kit";
import { Headline } from "../../extensions/token-stats/web/Headline.tsx";
import { WeekCard } from "../../extensions/token-stats/web/WeekCard.tsx";
import { TokenStatsBody } from "../../extensions/token-stats/web/TokenStatsBody.tsx";
import { ledgerAbsent, ledgerBackends } from "../../extensions/token-stats/web/backendLedger.ts";
import { COPILOT_LEDGER, type CorpusDoc, type LiveState, type ToExtension } from "../src/protocol";
import { Absent } from "./Absent";
import { TabLinks } from "./TabLinks";

export function OverviewView({ doc, why, scanning, live, post, askedLedger = null, here = null }: {
  doc: CorpusDoc | null;
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
  const progress = scanning
    ? <div className="empty ctx-note" role="status">Reading logs: {fmtCount(scanning.done)} of {fmtCount(scanning.total)}…</div>
    : null;
  if (!doc) return <>{progress}<Absent>{why ?? "No Claude Code logs have been read on this machine yet."}</Absent></>;
  const d = live?.doc ?? null;
  const copilot = doc.copilot && !ledgerAbsent(COPILOT_LEDGER.label, doc.copilot) ? [{ ...COPILOT_LEDGER }] : [];
  const claudeEmpty = tokenTotal(doc.totals) === 0;
  const openOn = copilot.length && (claudeEmpty || askedLedger === COPILOT_LEDGER.id) ? COPILOT_LEDGER.id : null;
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
          readings={d?.readings} ledgerTabs={[...copilot, ...(d ? ledgerBackends(d.backends) : [])]}
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
