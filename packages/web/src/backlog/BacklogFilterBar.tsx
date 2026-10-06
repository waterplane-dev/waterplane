/**
 * Search (and only search), the archived toggle, the status/age/clock/kind
 * chips — every count is the cut its tap opens, cross-counted — and the
 * filter bar saying what is hidden, `n of N`, with its clear.
 *
 * A REGION of the backlog sheet: no hooks of its own (a child's effects run
 * before its parent's, so a hook here would reorder them), only the model.
 * Shape: docs/notes/backlog-architecture.md.
 */
import { Archive, CalendarClock, Search, X } from "lucide-react";
import {
  AGE_LABEL, BACKLOG_AGES, BACKLOG_STATUSES, CATEGORY_BUCKETS, CATEGORY_CHIP_LABEL, categoryChipTitle,
  backlogCountWords, backlogFilterSentence,
} from "../backlogFilter";
import { track } from "../usage";
import type { BacklogModel } from "./backlogTypes";
import { CATEGORY_ICON } from "./backlogLabels";

export function BacklogFilterBar({ m }: { m: BacklogModel }) {
  const {
    archivedCount, base, clearFilter, counts, cut, filter, filtering, idsLabel, pickAge, pickCategory, pickClock,
    pickStatus, setText, showArchived, text, toggleArchived,
  } = m;
  return (
    <>
      {/* Search, and only search. It used to be one field doing two jobs — the
          query AND the draft for a new item — so typing something to add it
          emptied the list of everything that did not match it.

          The archived cut rides on the same row: it is the third thing that
          decides WHICH items are on screen, next to the query and the chips
          below, and as a full-width button of its own it read as a fourth
          command in a column of commands. */}
      <div className="form bl-searchrow">
        <div className="bl-search">
          <Search size={16} className="bl-search-icon" />
          <textarea
            className="search bl-combo" rows={1}
            placeholder="Search this repo…"
            value={text} onChange={(e) => setText(e.target.value)}
          />
          {text && <button className="bl-search-clear" onClick={() => setText("")} title="clear"><X size={16} /></button>}
        </div>
        {archivedCount > 0 && (
          <button className={`key ${showArchived ? "active" : ""}`} onClick={toggleArchived}
            title={showArchived ? "hide archived items again" : "show this repo's archived items too"}>
            <Archive size={14} /> {showArchived ? "hide" : "show"} archived ({archivedCount})
          </button>
        )}
      </div>

      {/* Status and age, as two rows of chips over THIS repo's items.
          Every count is a filter: the number on a chip is the length of the
          list its tap opens, cross-counted against whatever the other row has
          on (`backlogCounts`) — so "failed 3" with "past 24h" already on means
          three failed items from the past 24 hours, which is what a tap shows.
          A chip whose count is 0 is not drawn: on a phone this bar is competing
          with the list it filters.

          `wrap`, never the default horizontal scroll: the two kinds together
          are wider than a phone, so status sat on screen and every age chip sat
          past the right edge behind a gesture nobody discovers — with the
          `.spacer` drawn as a blank stretch where the wrap should have been.
          Wrapped, the spacer IS the break and both rows are readable. */}
      {base.length > 0 && (
        <div className="annot-tools wrap bl-filters">
          {BACKLOG_STATUSES.map((st) => counts.status[st] > 0 || filter.status === st ? (
            <button key={st} className={`key ${filter.status === st ? "active" : ""}`}
              title={`show only ${st} items${filter.age ? ` from the ${AGE_LABEL[filter.age]}` : ""}`}
              onClick={() => { track("action:backlog.filter.status"); pickStatus(st); }}>
              {st} {counts.status[st]}
            </button>
          ) : null)}
          <span className="spacer" />
          {BACKLOG_AGES.map((a) => counts.age[a] > 0 || filter.age === a ? (
            <button key={a} className={`key ${filter.age === a ? "active" : ""}`}
              title={`show only ${filter.status ? `${filter.status} ` : ""}items added ${a === "older" ? "over a week ago" : `in the ${AGE_LABEL[a]}`}`}
              onClick={() => { track("action:backlog.filter.age"); pickAge(a); }}>
              {AGE_LABEL[a]} {counts.age[a]}
            </button>
          ) : null)}
          {/* …and the third axis: WHAT KIND of thing each row is. Same rule as
              the two above it — the count is cross-counted against both of
              them (`backlogCounts`), a chip with nothing in it is not drawn,
              and the `spacer` puts it on a line of its own rather than letting
              the three kinds run together with the four ages.

              The `no kind` bucket is a chip like any other, because it is the
              cut a person most often wants: the rows nothing has said anything
              about yet are exactly the rows *name these N* is for, and the two
              controls sit one line apart. */}
          {/* **What is on a clock here** — the fourth axis, cross-counted like
              the other three. A person who queues work for a usage reset asks
              this repo one question ("what is scheduled, and in what order")
              and the list could not answer it: the rows were in it, in run
              order, wearing their clocks, spread through sixty others. The cut
              gathers them and the heads inside it say which instant each group
              waits for. One side only — nobody asks which rows have no clock. */}
          {(counts.clock > 0 || filter.clock) && <span className="spacer" />}
          {(counts.clock > 0 || filter.clock) && (
            <button className={`key ${filter.clock ? "active" : ""}`}
              title={filter.clock
                ? "show the items with no clock again"
                : `show only the ${counts.clock} item${counts.clock === 1 ? "" : "s"} waiting for an instant${filter.status ? ` · ${filter.status}` : ""} — grouped by the clock they share, in the order they will run`}
              onClick={() => { track("action:backlog.filter.clock"); pickClock(); }}>
              <CalendarClock size={12} style={{ verticalAlign: "-2px" }} /> on a clock {counts.clock}
            </button>
          )}
          {counts.category && CATEGORY_BUCKETS.some((c) => counts.category[c] > 0) && <span className="spacer" />}
          {CATEGORY_BUCKETS.map((c) => counts.category[c] > 0 || filter.category === c ? (
            <button key={c} className={`key ${filter.category === c ? "active" : ""}`}
              title={categoryChipTitle(c, filter.category === c)}
              onClick={() => { track("action:backlog.filter.category"); pickCategory(c); }}>
              {c === "none" ? null : (() => { const I = CATEGORY_ICON[c]; return <I size={12} style={{ verticalAlign: "-2px" }} />; })()}
              {" "}{CATEGORY_CHIP_LABEL[c]} {counts.category[c]}
            </button>
          ) : null)}
        </div>
      )}

      {filtering && (
        // Same bar, same words, same clear button as the launcher's and the
        // schedule sheet's: what is hidden, counted against the UNFILTERED list,
        // and the one way out.
        <div className="section filter-bar">
          <span className="filter-bar-txt">
            {backlogFilterSentence(filter, idsLabel)}{" · "}{backlogCountWords(cut.length, base.length, filter)}
            {cut.length === 0 && " — nothing here is in that cut"}
          </span>
          <button className="filter-bar-clear" title="clear the filter — show every item in this repo again"
            onClick={() => { track("action:backlog.filter.clear"); clearFilter(); }}><X size={13} /> clear</button>
        </div>
      )}
    </>
  );
}
