/**
 * A row's verbs: edit, the wait verb, when / drop the
 * clock, fire, run it again, re-fire, open, check, validate, done, archive,
 * remove. A verb that cannot act is ABSENT with a sentence, never dimmed.
 *
 * A REGION of the backlog sheet: no hooks of its own (a child's effects run
 * before its parent's, so a hook here would reorder them), only the model.
 * Shape: docs/notes/backlog-architecture.md.
 */
import {
  AlarmClockOff, Archive, ArchiveRestore, ArrowRight, CalendarClock, CheckCheck, Hourglass, Pencil, RotateCcw,
  Sparkles, X,
} from "lucide-react";
import type { RowFacts } from "./BacklogRow";
import { ConfirmButton } from "../Confirm";
import { SKIP_QUEUE_BUSY_NOTE, skipQueueNote } from "../sendIntent";
import { RUN_AGAIN_LABEL, dropClockNote, holderOffer, runAgainRowNote } from "../backlogFilter";
import { track } from "../usage";
import type { BacklogModel } from "./backlogTypes";
import { dropOffered } from "./backlogLabels";
import { Button } from "../kit/Button";

export function RowActions({ m, row }: { m: BacklogModel; row: RowFacts }) {
  const { beginEdit, fireIntoBusy, here, p, queuedHere, runAgainOffered } = m;
  const { it } = row;
  // fire/re-fire = the MANUAL OVERRIDE: one tap, always. A busy checkout is SAID (title, `RowNotes`), never asked.
  const fireTitle = fireIntoBusy(it) ? `${skipQueueNote(!it.targetSessionId)} — ${SKIP_QUEUE_BUSY_NOTE}` : skipQueueNote(!it.targetSessionId);
  const holder = holderOffer(it, p.sessions);
  return (
              <div className="bl-actions">
                {p.online && <Button title="edit" onClick={() => beginEdit(it)}><Pencil size={14} /></Button>}
                {/* **One WHEN, one name.** This verb was `queue here`, which is
                    the composer's `When free`, the next-prompt strip's `make it
                    wait` and the queue row's hourglass — four spellings of one
                    decision, three of them reachable from the same two taps.
                    It now wears the composer's own words and the composer's own
                    icon, and the three-sentence paragraph that used to explain
                    it is gone with the jargon it was explaining: the button
                    NAMES the session, and the group head above says where the
                    item went.

                    Rendered only where it can do something: a queued item, a
                    live session on screen, in the item's own repo. Elsewhere it
                    is ABSENT rather than dimmed, and the sheet says why once at
                    the top. Tapping it again takes the item back off, because a
                    queue built by mistake must be unpickable by the same gesture
                    that built it. */}
                {it.status === "queued" && here && here.cwd === it.repoDir && p.online && (
                  queuedHere(it)
                    ? <Button className="on" data-hint="backlog.queuehere"
                        title={`waiting for ${here.title} — it goes in when that session is next free, whether or not the global auto switch is on. Tap to take it back off`}
                        onClick={() => { track("action:backlog.unqueuehere"); p.verbs.onQueueHere(it.id, ""); }}>
                        <Hourglass size={14} /> waits for {here.title}
                      </Button>
                    : <Button data-hint="backlog.queuehere"
                        title={`hand it to ${here.title} — it goes to the bottom of that session's queue and runs when the session is next free, whether or not the global auto switch is on`}
                        onClick={() => { track("action:backlog.queuehere"); p.verbs.onQueueHere(it.id, here.id); }}>
                        <Hourglass size={14} /> when {here.title} is free
                      </Button>
                )}
                {/* Never gated on a session existing any more. It was — "open a
                    session for this item first", a dimmed button on a phone
                    where the title explaining it is invisible — because there
                    was one shared conversation per repo and somebody had to
                    start it. Firing opens one now, so the only thing left that
                    can stop this is the link, which says so. */}
                {/* **The two verbs a clock adds**, and neither is drawn on a row
                    without one (`it.at` absent ⇒ the row this sheet has always
                    drawn) nor on a RUNNING row, where an edit describes
                    something that never happened and the host refuses it.

                    *when* is the SEND sheet, seeded from this row: a clock is a
                    whole rule and this app has exactly one surface that
                    composes one. *drop the clock* is the answer to the state a
                    one-off cannot leave — its instant went by, it cannot be
                    re-armed, and `re-fire` beside it runs it THIS SECOND in a
                    session of its own rather than putting it back in the queue. */}
                {it.at && dropOffered(it) && p.online && (
                  <>
                    <Button title="change its time — the send sheet, with this row already in it"
                      onClick={() => { track("action:backlog.editwhen"); p.verbs.onEditWhen(it.id); }}>
                      <CalendarClock size={14} /> when
                    </Button>
                    <ConfirmButton confirm="drop it?" title={dropClockNote(it.status as "queued" | "failed")}
                      onConfirm={() => { track("action:backlog.dropclock"); p.verbs.onDropClock(it.id, it.status as "queued" | "failed"); }}>
                      <AlarmClockOff size={14} /> drop the clock
                    </ConfirmButton>
                  </>
                )}
                {/* The session a `serial` hold waits behind — usually a question open in it (`holderOffer`). */}
                {holder && <Button data-hint="backlog.openholder" title={holder.title}
                  onClick={() => { track("action:backlog.openholder"); p.nav.onOpenSession(holder.sessionId); }}><ArrowRight size={14} /> {holder.label}</Button>}
                {/* Absent offline rather than dimmed — the banner at the top says why once. */}
                {it.status === "queued" && p.online && <Button className={it.manual ? "primary" : undefined} data-hint="backlog.fire" title={fireTitle} onClick={() => { track("action:backlog.fire"); p.verbs.onFire(it.id); }}>fire</Button>}
                {/* On a TIMED row this is the other half of the pair above, and
                    the title has to say which: it starts now and skips the
                    ladder (`runNow`), so seven taps put seven agents in one
                    worktree — where *drop the clock* hands all seven to the
                    queue that runs them one at a time. */}
                {/* **Two verbs, two promises: in turn, or this second.**
                    `run it again` puts the row back in the QUEUE — where auto
                    can finally see it — and `re-fire`,
                    right beside it, starts an agent now, past every rung of the
                    ladder. Nineteen `re-fire` taps are nineteen agents in one
                    worktree; nineteen of these are nineteen rows the queue runs
                    one at a time. The difference is the whole reason there are
                    two buttons, and `runAgainRowNote` above says it in words.

                    Drawn with the link down as well as up, alone among the
                    mutations on this sheet: `intent.requeue` is durable and the
                    host refuses it on a row that is no longer failed, so a tap
                    queued now is either still what was meant or never applied.
                    Not a `ConfirmButton` — the per-row tap is one row and its
                    own note says what it does; the BULK one asks, because a
                    number is not a list somebody has read. */}
                {runAgainOffered(it) && (
                  <Button data-hint="backlog.runagain" title={runAgainRowNote(it)}
                    onClick={() => {
                      track("action:backlog.runagain");
                      // **The tap carries the failure it SAW.** `finishedAt` is
                      // `Intent.settledAt` as this row was drawn with it, and
                      // the host refuses a re-queue whose `failedAt` does not
                      // match what is on disk. `failed` is a STATE, not an
                      // event: between an offline tap and its delivery the row
                      // can be revived elsewhere, run, and fail DIFFERENTLY —
                      // and a state-only guard would then run work nobody
                      // decided on, over a failure nobody read.
                      p.verbs.onRunAgain(it.id, it.finishedAt);
                    }}>
                    <RotateCcw size={14} /> {RUN_AGAIN_LABEL}
                  </Button>
                )}
                {(it.status === "done" || it.status === "failed") && p.online && <Button data-hint="backlog.refire" title={fireTitle} onClick={() => { track("action:backlog.refire"); p.verbs.onFire(it.id); }}>re-fire</Button>}
                {it.sessionId && <Button title="go to the session it ran in" onClick={() => p.nav.onOpenSession(it.sessionId!)}><ArrowRight size={14} /> open</Button>}
                {(it.status === "done" || it.status === "failed" || it.status === "running") && p.online && (
                  it.checkStatus === "checking"
                    ? <span className="bl-waiting"><CheckCheck size={14} /> checking…</span>
                    : <Button title="check if implemented" onClick={() => p.verbs.onCheck(it.id)}>
                        <CheckCheck size={14} /> check
                      </Button>
                )}
                {(it.status === "done" || it.status === "failed" || it.status === "running") && p.online && (
                  it.validateStatus === "validating"
                    ? <span className="bl-waiting"><Sparkles size={14} /> validating…</span>
                    : <Button title="validate the expected outcome & get next steps" onClick={() => p.verbs.onValidate(it.id)}>
                        <Sparkles size={14} /> validate
                      </Button>
                )}
                {/* "done" on a running item is the stalest mutation of the lot: the
                    snapshot says running, the agent may have finished (or failed)
                    minutes ago. Same gate as fire/remove. */}
                {it.status === "running" && p.online && <Button data-hint="backlog.done" onClick={() => { track("action:backlog.done"); p.verbs.onDone(it.id); }}>done</Button>}
                {it.status !== "running" && p.online && (it.archived
                  ? <Button title="unarchive" onClick={() => p.verbs.onArchive(it.id, false)}><ArchiveRestore size={14} /></Button>
                  : <Button title="archive" onClick={() => p.verbs.onArchive(it.id, true)}><Archive size={14} /></Button>)}
                {p.online && <Button variant="danger" onClick={() => { track("action:backlog.remove"); p.verbs.onRemove(it.id); }}><X size={16} /></Button>}
              </div>
  );
}
