/**
 * The all-sessions screen's findings and its scope cards — kept out of
 * `TokenStatsSheet.tsx`, which is past three thousand lines already.
 *
 * - `InsightsPanel` — `statsInsights.ts`'s sentences. Nothing here acts: each
 *   finding carries a "try" line a person reads, never a button that applies it.
 * - `TopConvos` — the dearest conversations, agents folded in, each with the
 *   door the context sheet already has: *explain the cost*, which starts a new
 *   session that reads that one log and proposes fixes without making any.
 * - `ScopeCard` — the box a filter lives in. The chip row is the card's HEAD
 *   and everything it changes is inside the border, so which data a filter
 *   moves is read off the edge of the box rather than off the order of the
 *   screen. Every section inside repeats the scope in its own heading
 *   (`ScopeTag`), so a chart scrolled to in the middle still says what it shows.
 */
import { useState, type ReactNode } from "react";
import { Lightbulb, SearchCheck, BarChart3 } from "lucide-react";
import { fmtCount, fmtUsd, tokenTotal, type TokenConvo } from "@waterplane/shared";
import type { Insight } from "./statsInsights.ts";

export function InsightsPanel({ items }: { items: Insight[] }) {
  if (!items.length) return null;
  return (
    <div className="ts-insights">
      <div className="ts-insights-head"><Lightbulb size={14} /> What drives the cost</div>
      {items.map((i) => (
        <div key={i.id} className="ts-insight">
          <div className="ts-insight-head">{i.head}</div>
          <div className="ts-insight-body">{i.body}</div>
          {i.tryThis && <div className="ts-insight-try"><b>Try:</b> {i.tryThis}</div>}
        </div>
      ))}
    </div>
  );
}

function when(ms: number | null): string {
  if (ms == null) return "";
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** A conversation's span as a date or a date range. */
function span(c: TokenConvo): string {
  const a = when(c.firstAt), b = when(c.lastAt);
  return a && b && a !== b ? `${a} – ${b}` : a || b;
}

/** Rows shown before *show all*: five is a phone screen of them. */
const TOP_SHOWN = 5;

export function TopConvos({ rows, total, nameOf, onExplain, isLive, onOpen }: {
  /** Ranked by cost on the host; drawn in that order and IN MONEY whatever the
   *  screen's metric — a list called "costliest" printing token counts that
   *  do not descend reads as a sorting bug. Tokens ride in the facts line. */
  rows: TokenConvo[];
  /** The corpus's list-price total, for each row's share. */
  total: number;
  /** A title for a conversation this phone knows (live or recent), by id. */
  nameOf?: (id: string) => string | undefined;
  /** Start a new session explaining this conversation's cost. Absent in a
   *  static render; then the rows are a list and say so. */
  onExplain?: (c: TokenConvo, title: string) => void;
  /** Whether a LIVE session here holds this conversation — the one case the
   *  context & cost sheet can be opened for it. */
  isLive?: (id: string) => boolean;
  onOpen?: (id: string) => void;
}) {
  const [all, setAll] = useState(false);
  if (!rows.length) return null;
  const shown = all ? rows : rows.slice(0, TOP_SHOWN);
  return (
    <div className="ts-convos">
      {shown.map((c) => {
        const v = c.cost.total;
        const title = nameOf?.(c.id) ?? `${c.label} · ${c.id.slice(0, 8)}`;
        const agentShare = tokenTotal(c.totals) > 0 ? Math.round((tokenTotal(c.agentTotals) / tokenTotal(c.totals)) * 100) : 0;
        const share = total > 0 ? v / total : 0;
        return (
          <div key={c.id} className="ts-convo">
            <div className="ts-barhead">
              <span className="ts-barlabel">{title}</span>
              <span className="ts-barval">
                {fmtUsd(v)}
                {total > 0 && <em>{share < 0.01 ? "<1" : Math.round(share * 100)}%</em>}
              </span>
            </div>
            <div className="ts-convo-facts">
              {c.label} · {span(c)} · {fmtCount(tokenTotal(c.totals))} tokens
              {c.agents > 0 && <> · {c.agents} subagents ({agentShare}% of it)</>}
              {c.coldUsd ? <> · {fmtUsd(c.coldUsd)} re-caching after breaks</> : null}
            </div>
            {onExplain && (
              <div className="ts-convo-acts">
                <button className="key" onClick={() => onExplain(c, title)}>
                  <SearchCheck size={13} /> explain the cost
                </button>
                {onOpen && isLive?.(c.id) && (
                  <button className="key" onClick={() => onOpen(c.id)}>
                    <BarChart3 size={13} /> context & cost
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
      {rows.length > TOP_SHOWN && (
        <button className="key ts-convos-more" onClick={() => setAll((x) => !x)}>
          {all ? `show the top ${TOP_SHOWN}` : `show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}

/** A filter-scoped region: the chip row is the head, the content is inside. */
export function ScopeCard({ title, chips, caption, children }: {
  title: string;
  chips: ReactNode;
  /** What the chips currently select, in words — "last 30 days, Aug 28 – Sep 26". */
  caption?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="ts-scope">
      <div className="ts-scope-head">
        <div className="ts-scope-title">{title}</div>
        <div className="ts-scope-chips">{chips}</div>
        {caption && <div className="ts-scope-caption">{caption}</div>}
      </div>
      <div className="ts-scope-body">{children}</div>
    </section>
  );
}

/** The scope a section inside a `ScopeCard` is showing, repeated in its head. */
export function ScopeTag({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <span className={`ts-scope-tag${muted ? " ts-scope-tag-muted" : ""}`}>{children}</span>;
}
