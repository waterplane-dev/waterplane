/**
 * Search (and only search), the archived toggle, the status/clock/age/kind
 * chips — every count is the cut its tap opens, cross-counted — and the
 * filter bar saying what is hidden, `n of N`, with its clear.
 *
 * A REGION of the backlog sheet: no hooks of its own (a child's effects run
 * before its parent's, so a hook here would reorder them), only the model.
 * Shape: docs/notes/backlog-architecture.md.
 */
import { Archive, CalendarClock, Search, X } from "lucide-react";
import {
  AGE_LABEL, CATEGORY_CHIP_LABEL, backlogCountWords, backlogFilterSentence, categoryChipTitle, drawnChips,
} from "../backlogFilter";
import { FilterChip } from "../kit/FilterChip";
import { chipText } from "../kit/chips";
import { track } from "../usage";
import type { BacklogModel } from "./backlogTypes";
import { CATEGORY_ICON } from "./backlogLabels";

export function BacklogFilterBar({ m }: { m: BacklogModel }) {
  const {
    archivedCount, base, counts, filter, filtering, pickAge, pickCategory, pickClock,
    pickStatus, setText, showArchived, text, toggleArchived,
  } = m;
  // Which chips exist at all is `drawnChips`' call, off the same counts the chips print.
  const shown = drawnChips(counts, filter);
  const anyChip = shown.status.length > 0 || shown.clock || shown.age.length > 0 || shown.category.length > 0;
  return (
    <>
      {/* Search, and only search. It used to be one field doing two jobs — the
          query AND the draft for a new item — so typing something to add it
          emptied the list of everything that did not match it.

          The archived cut rides on the same row: it is the third thing that
          decides WHICH items are on screen, next to the query and the chips
          below, and as a full-width button of its own it read as a fourth
          command in a column of commands. A filter chip like the rest, lit
          while archived rows are in the list. */}
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
          <FilterChip on={showArchived} onClick={toggleArchived}
            title={showArchived ? "hide archived items again" : "show this repo's archived items too"}>
            <Archive size={13} aria-hidden />{chipText("archived", { count: archivedCount })}
          </FilterChip>
        )}
      </div>

      {/* The cuts, as the kit's filter chips (`FilterChip`: tinted when lit, a ×
          to take it away — never the solid fill, which is a sheet's one primary
          verb). Four axes in at most three rows: what is happening to the rows
          (status, and the clock), when they were added, and what kind they are.

          Every count is a filter: the number on a chip is the length of the
          list its tap opens, cross-counted against whatever the other axes
          have on (`backlogCounts`) — so "failed · 3" with "past 24h" already
          on means three failed items from the past 24 hours, which is what a
          tap shows. A chip with nothing in it is not drawn, and neither is one
          that holds the whole list (it would cut nothing): on a phone this bar
          competes with the list it filters (`drawnChips`).

          `wrap`, never the default horizontal scroll: a chip past the right
          edge behind a gesture nobody discovers is a chip that does not exist. */}
      {base.length > 0 && anyChip && (
        <div className="bl-fchips">
          {(shown.status.length > 0 || shown.clock) && (
            <div className="fchips wrap">
              {shown.status.map((st) => (
                <FilterChip key={st} on={filter.status === st}
                  title={`show only ${st} items${filter.age ? ` from the ${AGE_LABEL[filter.age]}` : ""}`}
                  onClick={() => { track("action:backlog.filter.status"); pickStatus(st); }}>
                  {chipText(st, { count: counts.status[st] })}
                </FilterChip>
              ))}
              {/* **What is on a clock here** — the fourth axis, cross-counted like
                  the others. A person who queues work for a usage reset asks this
                  repo one question ("what is scheduled, and in what order") and
                  the list could not answer it: the rows were in it, in run order,
                  wearing their clocks, spread through sixty others. The cut
                  gathers them and the heads inside it say which instant each
                  group waits for. One side only — nobody asks which rows have no
                  clock. */}
              {shown.status.length > 0 && shown.clock && <span className="fchips-gap" aria-hidden />}
              {shown.clock && (
                <FilterChip on={!!filter.clock}
                  title={filter.clock
                    ? "show the items with no clock again"
                    : `show only the ${counts.clock} item${counts.clock === 1 ? "" : "s"} waiting for an instant${filter.status ? ` · ${filter.status}` : ""} — grouped by the clock they share, in the order they will run`}
                  onClick={() => { track("action:backlog.filter.clock"); pickClock(); }}>
                  <CalendarClock size={12} aria-hidden />{chipText("on a clock", { count: counts.clock })}
                </FilterChip>
              )}
            </div>
          )}
          {shown.age.length > 0 && (
            <div className="fchips wrap">
              {shown.age.map((a) => (
                <FilterChip key={a} on={filter.age === a}
                  title={`show only ${filter.status ? `${filter.status} ` : ""}items added ${a === "older" ? "over a week ago" : `in the ${AGE_LABEL[a]}`}`}
                  onClick={() => { track("action:backlog.filter.age"); pickAge(a); }}>
                  {chipText(AGE_LABEL[a], { count: counts.age[a] })}
                </FilterChip>
              ))}
            </div>
          )}
          {/* …and the third axis: WHAT KIND of thing each row is, counted by the
              same rule. The `no kind` bucket is a chip like any other, because
              it is the cut a person most often wants: the rows nothing has said
              anything about yet are exactly the rows *name these N* is for, and
              the two controls sit one line apart. */}
          {shown.category.length > 0 && (
            <div className="fchips wrap">
              {shown.category.map((c) => {
                const Icon = c === "none" ? null : CATEGORY_ICON[c];
                return (
                  <FilterChip key={c} on={filter.category === c}
                    title={categoryChipTitle(c, filter.category === c)}
                    onClick={() => { track("action:backlog.filter.category"); pickCategory(c); }}>
                    {Icon && <Icon size={12} aria-hidden />}{chipText(CATEGORY_CHIP_LABEL[c], { count: counts.category[c] })}
                  </FilterChip>
                );
              })}
            </div>
          )}
        </div>
      )}

      {filtering && !filter.ids && <CutBar m={m} />}
    </>
  );
}

/** What the cut hides, `n of N`, and its clear — above the rows on an ids cut. */
export function CutBar({ m }: { m: BacklogModel }) {
  const { base, clearFilter, cut, filter, idsLabel } = m;
  return (
    // The launcher's and schedule sheet's bar: hidden, `n of N`, one way out.
    <div className="section filter-bar">
      <span className="filter-bar-txt">
        {backlogFilterSentence(filter, idsLabel)}{" · "}{backlogCountWords(cut.length, base.length, filter)}
        {cut.length === 0 && " — nothing here is in that cut"}
      </span>
      <button className="filter-bar-clear" title="clear the filter — show every item in this repo again"
        onClick={() => { track("action:backlog.filter.clear"); clearFilter(); }}><X size={13} /> clear</button>
    </div>
  );
}
