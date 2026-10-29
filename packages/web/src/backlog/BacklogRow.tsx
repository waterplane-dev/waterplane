/**
 * One backlog row: the facts it is drawn from (`RowFacts`, handed to its
 * parts), the inline editor when it is open, the clock head inside the clock
 * cut, and the row's frame — pick box, number, title, text, thumbnails, chips,
 * notes, order buttons, verbs.
 *
 * A REGION of the backlog sheet: no hooks of its own, only the model.
 * Shape: docs/notes/backlog-architecture.md.
 */
import { Fragment } from "react";
import { ArrowDown, ArrowUp, CalendarClock, GripVertical, Sparkles } from "lucide-react";
import type { BacklogItem } from "@waterplane/shared";
import { isAgentPosted, imagePaths, itemHeadline } from "@waterplane/shared";
import { clockGroupWords, itemClockKey, realLabel, retimeEligible, rowStatusKey } from "../backlogFilter";
import { PickBox, toggled } from "../RetimeBar";
import type { BacklogModel } from "./backlogTypes";
import { RowActions } from "./RowActions";
import { RowChips } from "./RowChips";
import { RowEditor } from "./RowEditor";
import { RowNotes } from "./RowNotes";
import { NetStalled } from "../NetStalled";
import type { BLGroup } from "./useBacklogCuts";
import { Button } from "../kit/Button";

/** What one row's parts are drawn from, computed once per row. */
export interface RowFacts {
  it: BacklogItem; idx: number; g: BLGroup;
  up: string | undefined; down: string | undefined;
  agentPosted: boolean;
}

export function BacklogRow({ m, g, it, idx }: { m: BacklogModel; g: BLGroup; it: BacklogItem; idx: number }) {
  const {
    canDrag, clockCuts, dragId, editingId, filter, now, openText, p, picked, picking, setDragId, setPicked, drawSort,
    toggleText,
  } = m;
    // The move verbs trade neighbours ON SCREEN, so they exist only while the
    // screen is in run order; newest first, a neighbour is not a run seat.
    const up = drawSort === "run" ? g.items[idx - 1]?.id : undefined;
    const down = drawSort === "run" ? g.items[idx + 1]?.id : undefined;
    /** Posted by an agent through the host's loopback route — said as
     *  TEXT on the row, so the person can tell it from what they typed. */
    const agentPosted = isAgentPosted(it);
    const row: RowFacts = { it, idx, g, up, down, agentPosted };
    if (editingId === it.id) return <RowEditor m={m} it={it} />;
    /**
     * **The head over each clock's rows, and only inside the clock cut.**
     *
     * Outside it these rows sit in the repo's run order among untimed
     * ones, and a head there would claim a block that is not on screen.
     * Inside it the cut IS the block, so the head says the one thing a
     * person queueing work on a usage reset wants and could not get:
     * which instant this group waits for, how many of them there are, and
     * that they go one at a time. Drawn above the group's first row IN
     * THIS display group, so a clock split across two session queues
     * heads each part rather than neither.
     */
    const clockHead = (() => {
      if (!filter.clock || !it.at) return null;
      const key = itemClockKey(it);
      const cg = clockCuts.find((c) => c.key === key);
      if (!cg || g.items.find((x) => itemClockKey(x) === key)?.id !== it.id) return null;
      return (
        <div className="bl-group-head bl-clock-head">
          <span className="bl-group-title"><CalendarClock size={13} /> {clockGroupWords(cg, now)}</span>
          <span className="bl-group-meta">in this order</span>
        </div>
      );
    })();
    return (
      <Fragment key={it.id}>
      {clockHead}
      <div data-blid={it.id} className={`bl-row bl-${rowStatusKey(it)} ${dragId === it.id ? "dragging" : ""}`}>
        <div className="bl-head">
          {picking && retimeEligible(it) && (
            <PickBox on={picked.has(it.id)} onToggle={() => setPicked((prev) => toggled(prev, it.id))} />
          )}
          {/* The RUN seat in either view — newest first never renumbers a row. */}
          <span className="bl-num">{g.seats.get(it.id) ?? idx + 1}</span>
          <div className="bl-main">
            {/* The item's OWN WORDS, always — never `label`, which add()
                fills with the first 40 characters of this same text and
                which therefore rendered every row as a sentence cut off
                mid-clause. Closed, the CSS clamps it (three lines, enough
                to tell two similar instructions apart); open, it is the
                whole thing. A label a person actually typed is a
                different fact and gets its own line above. */}
            {/* **What this row is CALLED**, by the one display rule both
                ends share (`itemHeadline`): a title somebody typed wins,
                always, and a machine's stands only where a person put
                nothing. It used to be `realLabel` alone, which is the
                typed half of exactly that rule — so a row a pass had
                titled showed nothing at all.

                The two are drawn APART. A typed label is the row's own
                heading and reads as it always has; a derived headline
                wears the `Sparkles` mark this app uses wherever a cheap
                model wrote something, because the one thing a reader must
                be able to tell at a glance is whose words are at the top
                of their own list. */}
            {(() => {
              const typed = realLabel(it);
              if (typed) return <span className="bl-label">{typed}</span>;
              const machine = itemHeadline(it);
              if (!machine) return null;
              // **The mark is the AUTHOR's, not the field's.** A row can
              // carry a `headline` somebody typed into the edit form — the
              // host stamps it `hand` and no pass will touch it again — and
              // drawing `Sparkles` on that is this app telling a person
              // their own words were written by a model, which is the one
              // claim the author stamp exists to get right.
              const derived = it.headlineBy !== "hand";
              return (
                <span className={`bl-label${derived ? " bl-headline" : ""}`}>
                  {derived ? <Sparkles size={11} /> : null}{derived ? " " : ""}{machine}
                </span>
              );
            })()}
            <button
              className={`bl-text bl-text-btn ${openText.has(it.id) ? "open" : ""}`}
              title={openText.has(it.id) ? "collapse" : "expand — full task & continue in a session"}
              onClick={() => toggleText(it.id)}
            >
              {it.text}
            </button>
            {(() => {
              // A placeholder an agent wrote (`ios-<step>.png`, `*.png`) names no
              // file; a path that 404s anyway takes its frame with it rather
              // than drawing a broken image with its alt text over it.
              const imgs = imagePaths(it.text).filter((rp) => !/[<>*{}]/.test(rp));
              if (!imgs.length) return null;
              return (
                <div className="bl-thumbs">
                  {imgs.map((rp) => {
                    const src = p.nav.imageSrc(it.repoDir, rp);
                    return src ? (
                      <button key={rp} className="bl-thumb" title={`view & mark ${rp}`} onClick={() => p.verbs.onEditImage(it, rp)}>
                        <img src={src} alt="" loading="lazy"
                          onError={(e) => { (e.currentTarget.parentElement as HTMLElement).hidden = true; }} />
                      </button>
                    ) : null;
                  })}
                </div>
              );
            })()}
            <RowChips m={m} row={row} />
            <RowNotes m={m} row={row} />
            {/* Stalled on the API (R-connection-024): derived off the session, on the item. */}
            <NetStalled state={it.status} sessionId={it.sessionId} sessions={p.sessions} />
          </div>
          <div className="bl-order">
            {canDrag && (
              <Button
                className="drag-handle"
                title="drag to reorder"
                style={{ touchAction: "none", cursor: "grab" }}
                onPointerDown={(e) => { e.preventDefault(); setDragId(it.id); }}
              ><GripVertical size={14} /></Button>
            )}
            {up && p.online && <Button onClick={() => p.verbs.onSwap(it.id, up)} title="move up"><ArrowUp size={14} /></Button>}
            {down && p.online && <Button onClick={() => p.verbs.onSwap(it.id, down)} title="move down"><ArrowDown size={14} /></Button>}
          </div>
        </div>
        <RowActions m={m} row={row} />
      </div>
      </Fragment>
    );
}
