/** The two rate-limit windows, right now: their bars, the figure under each and the readings chart. */
import { useEffect } from "react";
import { Clock, Gauge, ScanLine } from "lucide-react";
import { fmtCount, fmtShare, fmtUsd, tokenTotal, type UsageHistoryDoc, type UsageInfo } from "@waterplane/shared";
import {
  type CutRefusal, cutRefusalText, isCut, LIVE_WINDOWS, type LiveWindowId, type WindowCut,
} from "./usageCut.ts";
import { ago, until, Button } from "@waterplane/kit";
import { USAGE_STALE_MS } from "./constants.ts";
import { resetWhen, short } from "./when.ts";
import { UsageSpark } from "./UsageSpark.tsx";

/**
 * The two rate-limit windows, right now — the half of "usage" that has a clock
 * on it.
 *
 * Everything else on this screen is history read out of the conversation logs:
 * true, cumulative, and unable to say whether a prompt sent in the next minute
 * will run. That question is the percentages scraped off the CLI's own
 * `/usage` screen, and it is only half-answered by a percentage: 90% of the
 * five-hour window with ten minutes left on it is a coffee, the same number
 * against a week that resets on Thursday is a plan change. So the reset
 * instant travels with each number here exactly as it does in `usageTitle`,
 * and BOTH windows are stated — the five-hour one paces the next hour, the
 * weekly one is what actually strands you for days.
 *
 * Degrades to absent, never to a guess: the scrape is a TUI parse (`host/
 * usage.ts`), a percentage it could not read prints as an em dash, and the
 * weekly reset is null whenever the screen named no DATE, because a bare
 * wall-clock time for a window that resets days out lands on the wrong day.
 */
export function LimitWindows({ usage, onRefresh, history, cuts, scope, onScope, compact = false }: {
  usage: UsageInfo | null;
  onRefresh?: (quiet?: boolean) => void;
  /**
   * The readings the host kept (`/api/usagelog`), or null while they are read or when the host
   * cannot be reached — then the charts say so in words. Read by `TokenStatsBody`, not here: the
   * week card calibrates its points off the same samples, and two reads of one log are two
   * instants drawn as one reading.
   */
  history: UsageHistoryDoc | null;
  /**
   * What each window has actually used, or why that cannot be said — the other
   * half of a percentage. Computed by the BODY and handed down, so the number
   * on this row and the cut the chip below takes are one call to `windowCut`
   * rather than two that have to agree. Absent on a render with no ledger
   * behind it (this component draws with `doc` null on purpose).
   */
  cuts?: Map<LiveWindowId, WindowCut | CutRefusal>;
  /** Which window the readouts below are scoped to, so the row can show itself
   *  as the live filter rather than as a second, unrelated control. */
  scope?: "all" | LiveWindowId;
  /** Taking the row's own numbers down to the readouts — a figure on a control
   *  is a filter. Absent ⇒ the line is text and nothing is tappable. */
  onScope?: (s: "all" | LiveWindowId) => void;
  /** The token sheet's "now" block (2026-10-15): bar, readings chart, figure and reset per window,
   *  without the per-window note — both windows stay above the span filter. The charts stay in the
   *  open: folded, the owner read them as gone. */
  compact?: boolean;
}) {
  // Opening this screen is the act of asking "where am I right now", so a
  // reading older than the host's own cache TTL is re-scraped on the way in —
  // quietly, since a toast for something nobody tapped is noise. Stale-only:
  // the scrape spawns a short `claude` PTY, and one per visit to a statistics
  // screen is a pty-table entry spent for a number that has not moved.
  useEffect(() => {
    if (!onRefresh) return;
    if (usage?.checkedAt && Date.now() - usage.checkedAt < USAGE_STALE_MS) return;
    onRefresh(true);
    // Once per mount, deliberately: this must not re-fire as the snapshot
    // arrives and the age it is testing changes underneath it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The readings the host kept, which is the only history either window has —
  // read by the body (re-read whenever a new scrape lands, no cache).
  const doc = history;
  const samples = doc?.samples ?? [];

  /** The reasons no token figure could be put on a row, de-duplicated: both
   *  windows normally fail for the same reason and printing it twice reads as
   *  two faults. */
  const refusals = [...new Set(
    [...(cuts?.entries() ?? [])]
      .filter(([, c]) => !isCut(c))
      .map(([id, c]) => {
        const spec = LIVE_WINDOWS.find((w) => w.id === id)!;
        return cutRefusalText(spec, c as CutRefusal);
      }),
  )];

  const rows = [
    {
      label: "5-hour session",
      which: "session" as const,
      pct: usage?.sessionPct ?? null,
      reset: usage?.sessionResetAt ?? null,
      note: "A rolling five-hour window. This is the one you can sit out.",
    },
    {
      label: "Week (all models)",
      which: "week" as const,
      pct: usage?.weeklyPct ?? null,
      reset: usage?.weeklyResetAt ?? null,
      note: "The account-wide week, across every model. This is the one that strands you for days.",
    },
  ];

  return (
    <div className="ts-lims">
      <div className="section section-head">
        <span><Gauge size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />Right now</span>
        {/* Not sheet chrome: this is a section's own verb, and it means
            something else than the head's rescan (re-scrape the CLI's `/usage`
            SCREEN vs re-scan the conversation logs). It wore the head's
            `RefreshCw`, told apart only by a `title` nobody on a phone can see,
            so it carries the word AND its own glyph: `ScanLine`, reading a
            screen, while `RefreshCw` stays the head's "read the document
            again" as on every other sheet. One icon per meaning. */}
        {onRefresh && (
          <Button onClick={() => onRefresh()}
            title="re-read the CLI’s /usage screen (spawns a short claude probe)">
            <ScanLine size={14} /> re-read
          </Button>
        )}
      </div>

      {rows.map((r) => (
        <div key={r.label} className="ts-lim">
          <div className="ts-barhead">
            <span className="ts-barlabel">{r.label}</span>
            <span className={`ts-barval${r.pct != null && r.pct >= 80 ? " hot" : ""}`}>
              {r.pct != null ? `${r.pct}% used` : "—"}
            </span>
          </div>
          <div className="ts-bartrack">
            <span className={`ts-barfill${r.pct != null && r.pct >= 80 ? " hot" : ""}`}
              style={{ width: `${r.pct ?? 0}%` }} />
          </div>
          <UsageSpark samples={samples} which={r.which} reset={r.reset} pct={r.pct}
            everyMs={doc?.everyMs ?? 0} />
          {/* What the percentage is a percentage OF. The bar says 50%; this
              says 9.1B tokens and $7.40 at list prices, which is the half of
              the answer the scrape cannot carry. Drawn only where the hour
              record can actually be cut — a refusal is worded once, below the
              pair, rather than twice here. */}
          <WindowUsed cut={cuts?.get(r.which)} scope={scope} onScope={onScope} />
          <div className="ts-lim-sub">
            {r.reset
              ? <><Clock size={11} style={{ verticalAlign: "-1px" }} /> Resets {resetWhen(r.reset)} — in {until(r.reset)}. </>
              : r.pct != null
                ? <>The screen did not name a reset time for this window. </>
                : null}
            {!compact && r.note}
          </div>
        </div>
      ))}

      <div className="empty ts-foot">
        {/* A REMEMBERED reading says so, in words, under a head that says
            "Right now". The host keeps the last reading across a restart so the
            gauge does not blank every time a new web bundle ships, and a
            percentage nobody has re-read since then is a floor, not a
            reading — the window has only ever filled further since. Windows
            whose reset has passed are already gone by the time this draws
            (`host/usage.ts`), so what is on screen is always the window it
            names. */}
        {usage?.remembered
          ? <>Kept from before this desktop’s daemon last restarted, read {ago(usage.checkedAt)} — nothing has re-read the CLI’s <code>/usage</code> screen since, so both windows can only have filled further. Tap <em>re-read</em> for the live figure. </>
          : usage?.checkedAt
            ? <>Read off the CLI’s own <code>/usage</code> screen {ago(usage.checkedAt)}{usage.ok ? "" : ", which could not be parsed"}. </>
            : <>The <code>/usage</code> screen has not been read yet on this desktop, so these two windows are unknown. </>}
        {!compact && "The history below comes from the conversation logs, not from this."}
        {/* Why a window has no token figure, once per reason rather than once
            per row — the two windows usually fail for the same reason and the
            sentence is a paragraph, not a chip. */}
        {refusals.map((x) => <span key={x}> {x}</span>)}
      </div>
    </div>
  );
}

/**
 * The tokens, the money and the models inside ONE live window — the line
 * directly under its bar.
 *
 * A button rather than a caption wherever the readouts can take the cut,
 * because a figure on a control is a filter: tapping "9.1B tokens" scopes the
 * hero, the composition strip, the tiles and the model bars to exactly those
 * tokens rather than leaving the reader to re-derive them. With no handler it
 * renders as plain text and claims nothing about being tappable.
 *
 * Absent — not zeroed, not dimmed — when the cut cannot be taken; the reason
 * is one sentence under the pair, from `cutRefusalText`.
 */
function WindowUsed({ cut, scope, onScope }: {
  cut?: WindowCut | CutRefusal;
  scope?: "all" | LiveWindowId;
  onScope?: (s: "all" | LiveWindowId) => void;
}) {
  if (!cut || !isCut(cut)) return null;
  const tok = tokenTotal(cut.totals);
  if (!tok) {
    return <div className="ts-lim-used none">Nothing counted in this window yet.</div>;
  }
  const on = scope === cut.id;
  const top = cut.models[0];
  const body = <>
    <b>{fmtCount(tok)}</b> tokens · <b>{fmtUsd(cut.cost.total)}</b> at list prices
    {/* Which model carried it, in the space of a clause: the leader's share
        and how many others there were. `claude-` is stripped the way
        `ModelLegend` strips it — the prefix is on every id here and spends a
        third of a phone-width line saying nothing. `fmtShare` is what keeps
        "99.8% and four more models" from printing as `100%`. */}
    {cut.modelSplit && top
      ? <> · {cut.models.length === 1
          ? <>all on {short(top.label)}</>
          : <>{fmtShare(tokenTotal(top) / tok)} {short(top.label)}, {cut.models.length - 1} more</>}</>
      : null}
  </>;
  if (!onScope) return <div className="ts-lim-used">{body}</div>;
  return (
    <button type="button" className={`ts-lim-used${on ? " active" : ""}`}
      onClick={() => onScope(on ? "all" : cut.id)}
      title={on ? "back to the all-time readouts" : "take the readouts below down to this window"}>
      {body}
    </button>
  );
}
