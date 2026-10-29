/**
 * A row's meta line: status, kind, *naming…*, ages, turns, *continued*,
 * close/budget answers, its clock and seat, holds, `▶ next`, target state,
 * the schedule link, *you placed this*.
 *
 * A REGION of the backlog sheet: no hooks of its own (a child's effects run
 * before its parent's, so a hook here would reorder them), only the model.
 * Shape: docs/notes/backlog-architecture.md.
 */
import { ArrowDown, ArrowUp, CalendarClock, DoorClosed, DoorOpen, Flag, Gauge, Hand, History, Hourglass, Play, Sparkles, Wallet } from "lucide-react";
import type { RowFacts } from "./BacklogRow";
import { budgetWaived } from "@waterplane/shared";
import { budgetChipWords } from "../budgetInput";
import { launchClause, launchWords } from "../sendIntent";
import {
  AGE_LABEL, HOLD_FOR_HOST_TITLE, ageBucket, clockSeat, clockSeatWords, CLOCK_MOVE_NOTE, clockWords, fmtSpan,
  fromScheduleWords, holdChipWords, pastBudgetChipWords, PAST_BUDGET_TITLE, rowStatusKey, rowStatusWord,
} from "../backlogFilter";
import { ago } from "../format";
import { budgetEditable, closeChipWords, opensOwnSession } from "../autoSessions";
import { track } from "../usage";
import type { BacklogModel } from "./backlogTypes";
import { CATEGORY_ICON, dropOffered } from "./backlogLabels";

export function RowChips({ m, row }: { m: BacklogModel; row: RowFacts }) {
  const { clockCuts, namingIds, nextFireIds, now, p, targetClosed, targetReopens } = m;
  const { it } = row;
  return (
                  <span className="bl-meta">
                    <span className={`tag-${rowStatusKey(it)}`}>{rowStatusWord(it)}</span>
                    {/* **What kind of thing this row is** — icon and word, and
                        NOTHING AT ALL when nobody has said. Absent means nobody
                        said (`naming.ts`), which is a real answer: a default
                        bucket drawn here would file every un-looked-at row
                        under a heading its author never chose, and the `no
                        kind` chip in the filter bar is where that answer is
                        countable. No colour per kind — see `CATEGORY_ICON`. */}
                    {it.category && (() => {
                      const I = CATEGORY_ICON[it.category];
                      return (
                        <span className="bl-chip bl-cat">
                          <I size={11} style={{ verticalAlign: "-1px" }} /> {it.category}
                        </span>
                      );
                    })()}
                    {/* A pass has this row in hand right now. Its own chip
                        rather than a spinner over the whole sheet: naming is
                        per row, the host says which rows, and a row nobody is
                        naming must not look busy. */}
                    {namingIds.has(it.id) && (
                      <span className="bl-chip bl-naming" title="a naming pass is reading this row's words right now">
                        <Sparkles size={11} style={{ verticalAlign: "-1px" }} /> naming…
                      </span>
                    )}
                    {/* How old, and how long it took — the two facts a list of
                        fifty-two rows cannot be triaged without. `added` is the
                        age the filter chips bucket on, so the row and the chip
                        are reading the same clock. An absent timestamp prints
                        nothing rather than a zero. */}
                    <span className="bl-age" title={`added ${new Date(it.createdAt).toLocaleString()} (${AGE_LABEL[ageBucket(it.createdAt, now)]})`}>
                      added {ago(it.createdAt)}
                    </span>
                    {it.status === "running" && it.startedAt != null && (
                      <span className="bl-age" title={`started ${new Date(it.startedAt).toLocaleString()}`}>
                        running {fmtSpan(now - it.startedAt)}
                      </span>
                    )}
                    {it.status !== "running" && it.finishedAt != null && (
                      <span className="bl-age" title={`finished ${new Date(it.finishedAt).toLocaleString()}`}>
                        {it.status === "failed" ? rowStatusWord(it) : "finished"} {ago(it.finishedAt)}
                        {it.startedAt != null && it.finishedAt >= it.startedAt ? ` · took ${fmtSpan(it.finishedAt - it.startedAt)}` : ""}
                      </span>
                    )}
                    {it.checkedAt != null && <span className="bl-age" title={`checked ${new Date(it.checkedAt).toLocaleString()}`}>checked {ago(it.checkedAt)}</span>}
                    {it.validatedAt != null && <span className="bl-age" title={`validated ${new Date(it.validatedAt).toLocaleString()}`}>validated {ago(it.validatedAt)}</span>}
                    {/* How many turns it carries. A COUNT, never the words —
                        the chain itself lives on the host, and shipping it here
                        would put a whole prompt into every list every phone
                        renders. Absent or 1 is the ordinary one-turn item. */}
                    {(it.steps ?? 1) > 1 && (
                      <span className="bl-age" title="delivered one turn at a time, in one session">{it.steps} turns</span>
                    )}
                    {/* It opens by picking up this repo's last conversation
                        (`--continue`) rather than starting clean. Said on the
                        row because it is the difference between a cheap run and
                        one that pays for a whole window again, every turn. */}
                    {it.resume && (
                      <span className="bl-age" title="it reopens this repo's last conversation instead of starting clean">
                        <History size={11} style={{ verticalAlign: "-1px" }} /> continued
                      </span>
                    )}
                    {/* The item's OWN close-when-done answer. A row that
                        inherits says nothing here (the open row says it in
                        full); a row aimed at an existing session opened none. */}
                    {opensOwnSession(it) && closeChipWords(it.closeWhenDone) && (
                      <span className="bl-age">
                        {it.closeWhenDone ? <DoorClosed size={11} style={{ verticalAlign: "-1px" }} /> : <DoorOpen size={11} style={{ verticalAlign: "-1px" }} />}{" "}
                        {closeChipWords(it.closeWhenDone)}
                      </span>
                    )}
                    {/* Its session gets the follow-up flag once done. Absent says nothing. */}
                    {opensOwnSession(it) && it.flagWhenDone && (
                      <span className="bl-age fu-launch" title="its session gets the follow-up flag once it is done">
                        <Flag size={11} style={{ verticalAlign: "-1px" }} /> flag when done
                      </span>
                    )}
                    {/* The model a WAITING row opens on (`BacklogItem.launch`), in the Send sheet's words. Defaults say nothing. */}
                    {opensOwnSession(it) && it.status === "queued" && launchClause(it.launch) && (
                      <span className="bl-age">opens on {launchWords(it.launch)}</span>
                    )}
                    {/* The cap the session this row opens is born with
                        (`BacklogItem.budget`) — the cap as typed, in
                        `sessionBudgetLabel`'s words. Absent says nothing. */}
                    {opensOwnSession(it) && it.budget && (budgetEditable(it) && p.online ? (
                      // A queued row's cap is a tap away from changing (R-automation-044).
                      <button className={`bl-age${m.budgetOpen.has(it.id) ? " active" : ""}`} aria-pressed={m.budgetOpen.has(it.id)}
                        onClick={() => m.toggleBudget(it.id)}>
                        <Wallet size={11} style={{ verticalAlign: "-1px" }} /> {budgetChipWords(it.budget)}
                      </button>
                    ) : (
                      <span className="bl-age">
                        <Wallet size={11} style={{ verticalAlign: "-1px" }} /> {budgetChipWords(it.budget)}
                      </span>
                    ))}
                    {/* **This row waits on a CLOCK.**
                        A one-off aimed at one place is a backlog row whose WHEN
                        happens to be an instant — it used to be a card in the
                        Schedules sheet, which is the one screen whose verbs
                        (arm, pause, skip) it cannot use, and it was missing from
                        the list its repo's agent is actually fed from. The rule
                        is `describeRule`'s own words, never re-worded here.
                        Absent `at` is every row written before this field and
                        every untimed item: they render exactly as before. */}
                    {it.at && (
                      <span className="bl-chip bl-clock"
                        title="this one waits for an instant rather than for its turn — tap “when” to change it, or “drop the clock” to put it back in the queue">
                        <CalendarClock size={11} style={{ verticalAlign: "-1px" }} /> {clockWords(it.at, now, it.status)}
                      </span>
                    )}
                    {/* **Which of the items on this clock runs first.**
                        Several rows armed for one instant are a QUEUE — twelve
                        live one-offs on this desktop were all waiting for the
                        same weekly reset, seven of them in one repo — and the
                        only answer to "which goes first" was to know the host
                        sorts on `order ?? createdAt` and to compare creation
                        times nobody is shown. The seat is read off the repo's
                        own run order (`clockCuts`, over `base`), so a filter
                        cannot change what it says, and the two verbs move the
                        row INSIDE its group: `backlog.swap` trades two rows'
                        positions, so an item on a different clock is never
                        crossed. Drawn only where there is a queue to be in —
                        one row on its own clock is not one. */}
                    {(() => {
                      const seat = it.at ? clockSeat(clockCuts, it.id) : null;
                      if (!seat) return null;
                      const g = clockCuts.find((c) => c.items.some((x) => x.id === it.id))!;
                      const up = g.items[seat.idx - 1]?.id;
                      const down = g.items[seat.idx + 1]?.id;
                      return (
                        <span className="bl-chip bl-clock-seat" title={CLOCK_MOVE_NOTE}>
                          {clockSeatWords(seat)}
                          {p.online && up && (
                            <button className="bl-seat-move" aria-label="run earlier on this clock"
                              title={`run it earlier on this clock — ${CLOCK_MOVE_NOTE}`}
                              onClick={() => { track("action:backlog.clock.up"); p.verbs.onSwap(it.id, up); }}>
                              <ArrowUp size={11} />
                            </button>
                          )}
                          {p.online && down && (
                            <button className="bl-seat-move" aria-label="run later on this clock"
                              title={`run it later on this clock — ${CLOCK_MOVE_NOTE}`}
                              onClick={() => { track("action:backlog.clock.down"); p.verbs.onSwap(it.id, down); }}>
                              <ArrowDown size={11} />
                            </button>
                          )}
                        </span>
                      );
                    })()}
                    {/* The schedule vocabulary's *wait until free*, host-wide
                        half. Its own chip because it is the one wait this list
                        cannot show: `serial` is "one at a time in this repo",
                        which the order on screen already says, and this one is
                        about every other repo on the desktop. */}
                    {it.holdForHost && (
                      <span className="bl-chip bl-hold" title={HOLD_FOR_HOST_TITLE}>
                        {/* The clause was in the `title` alone, and a title is
                            invisible on a phone — the rule `Unavailable.tsx`
                            exists for. "The hold survives a dropped clock" is
                            something a person needs BEFORE tapping the button
                            two lines down, so it is drawn exactly where that
                            button is drawn and nowhere else. */}
                        <Hourglass size={11} style={{ verticalAlign: "-1px" }} /> {holdChipWords(!!it.at && dropOffered(it) && p.online)}
                      </span>
                    )}
                    {/* A person let this past the budget (the re-time sheet's
                        *let past the budget*): only the budget — it still runs
                        in turn. The tap is the undo, and says so in text —
                        only on a WAITING row (the host refuses a waive on one
                        already going), and nothing at all once the window the
                        waiver was granted in has reset (`budgetWaived`). */}
                    {budgetWaived(it, now) && (p.online && it.status === "queued" ? (
                      <button className="bl-chip bl-hold" title={PAST_BUDGET_TITLE}
                        onClick={() => { track("action:backlog.holdforbudget"); p.verbs.onHoldForBudget(it.id); }}>
                        <Gauge size={11} style={{ verticalAlign: "-1px" }} /> {pastBudgetChipWords(true)}
                      </button>
                    ) : (
                      <span className="bl-chip bl-hold" title={PAST_BUDGET_TITLE}>
                        <Gauge size={11} style={{ verticalAlign: "-1px" }} /> {pastBudgetChipWords(false)}
                      </span>
                    ))}
                    {nextFireIds.has(it.id) && (
                      <span className="bl-next" title="auto will run this one next"><Play size={10} style={{ verticalAlign: "-1px" }} /> next</span>
                    )}
                    {/* It said *"it runs in a new one instead"*, which the host
                        has never done: a session-target row is held on
                        `sessionGone` until somebody moves it, and a hand `fire`
                        resolves the same dead id. The chip now says the state
                        it is in and what ends it. */}
                    {targetClosed(it) && (
                      <span className="bl-next" title="the session it was aimed at has exited — nothing re-aims it; edit it to pick another session, take the aim off, or remove it">
                        target closed — held
                      </span>
                    )}
                    {/* The opposite promise, and it is a promise this host does
                        keep: the row remembers the CONVERSATION, so the closed
                        session costs it nothing but a reopen. Said on the row
                        because *session closed* otherwise reads as the held
                        state one chip up. */}
                    {targetReopens(it) && (
                      <span className="bl-next" title="the session it was aimed at has exited, but this row remembers the conversation — at its time it reopens that conversation in a session of its own and sends the words there">
                        session closed — reopens its conversation
                      </span>
                    )}
                    {/* **Where this row came from, when it was a rule.**
                        A schedule's whole job is to write rows here, and until
                        this chip neither list named the other: the reader had to
                        remember that "weekly security sweep" at 03:00 was a
                        standing rule and then go and find it in another sheet.
                        One tap opens Schedules on exactly that rule — a link,
                        not a search. Absent when the phone cannot know (see
                        `scheduleFor`), never guessed. */}
                    {(() => {
                      const sch = p.nav.scheduleFor?.(it);
                      if (!sch) return null;
                      return p.nav.onOpenSchedule ? (
                        <button className="bl-chip bl-merged"
                          title={`open the schedule “${sch.name}” — the rule that wrote this row`}
                          onClick={() => { track("action:backlog.fromschedule"); p.nav.onOpenSchedule!(sch.id, sch.name); }}>
                          <CalendarClock size={11} style={{ verticalAlign: "-1px" }} /> {fromScheduleWords(sch.name)}
                        </button>
                      ) : (
                        <span className="bl-chip bl-merged">
                          <CalendarClock size={11} style={{ verticalAlign: "-1px" }} /> {fromScheduleWords(sch.name)}
                        </span>
                      );
                    })()}
                    {/* **Two things set this now, so the words are true of
                        both.** It was `placed by you` / "you dragged this one
                        here", which was the whole story while a drag was the
                        only thing that stamped `handOrdered`. An assessment's
                        ranking, approved at apply time, stamps it too — and a
                        chip saying "you dragged this" about an order a model
                        proposed and a person signed off is a claim about what
                        somebody did, which is the kind of thing this app is
                        careful not to get wrong. One field, because both ARE
                        one fact: a position a person decided. */}
                    {it.handOrdered && (
                      <span className="bl-chip bl-hand" title="its position was decided by you — a drag, or an assessment ranking you approved">
                        <Hand size={11} style={{ verticalAlign: "-1px" }} /> you placed this
                      </span>
                    )}
                  </span>
  );
}
