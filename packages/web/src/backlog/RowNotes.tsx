/**
 * The sentences under a row's chips — what wrote it, what each offered verb
 * does, why a verb is absent — then its waiting line, the slot list, its
 * close-when-done choice, and the check/validate details.
 *
 * A REGION of the backlog sheet: no hooks of its own (a child's effects run
 * before its parent's, so a hook here would reorder them), only the model.
 * Shape: docs/notes/backlog-architecture.md.
 */
import { ArrowRight, ChevronDown, ChevronRight, DoorClosed, Wallet, X } from "lucide-react";
import { RowFlagChoice } from "./RowFlagChoice";
import { RowBudgetEdit } from "./RowBudgetEdit";
import { RadioRows, Button } from "../kit";
import type { RowFacts } from "./BacklogRow";
import { AGENT_POSTED_WORDS, MANUAL_HOLD_TEXT } from "@waterplane/shared";
import { skipQueueNote } from "../sendIntent";
import {
  HEADLINE_BY_WORDS, dropClockNote, requeuedWords, runAgainClosedNote, runAgainRowNote,
} from "../backlogFilter";
import { ago } from "../format";
import {
  CLOSE_CHOICES, budgetEditable, closeChoiceLabel, closeChoiceOf, closeEffectWords, closeOneLabel, opensOwnSession, slotHeld,
  slotSessionState,
} from "../autoSessions";
import { toggled } from "../RetimeBar";
import { track } from "../usage";
import type { BacklogModel } from "./backlogTypes";
import { CHECK_ICON, CHECK_LABEL, VALIDATE_ICON, VALIDATE_LABEL, dropOffered } from "./backlogLabels";

export function RowNotes({ m, row }: { m: BacklogModel; row: RowFacts }) {
  const {
    fireIntoBusy, now, openDetail, openText, openValidate, p, runAgainHeld, runAgainOffered, setSlotOpen, slotOpen,
    slotSessions, targetLive, toggleDetail, toggleValidate,
  } = m;
  const { it, agentPosted } = row;
  return (
    <>
                  {/* What wrote this row, when it was an agent. */}
                  {agentPosted && openText.has(it.id) && <span className="bl-smart-note">{AGENT_POSTED_WORDS}</span>}
                  {it.manual && it.status === "queued" && <span className="bl-hold">{MANUAL_HOLD_TEXT}</span>}
                  {/* **What dropping this row's clock does — as text.**
                      It was a `title` on the button, which on a phone is no
                      sentence at all, and the clause it carried is the whole
                      answer to "how do I run the ones that were skipped": the
                      row joins the queue, and auto takes it from there. Drawn only where the verb is drawn, so a row
                      nobody can act on says nothing extra, and the BUTTON wears
                      the same string as its title — one claim, not two copies
                      of it. */}
                  {it.at && dropOffered(it) && p.online && (
                    <span className="bl-smart-note">{dropClockNote(it.status as "queued" | "failed")}</span>
                  )}
                  {/* **What `run it again` does — as text, beside the button
                      that does it.** `dropClockNote`'s rule and the same one
                      string in both homes: a `title` is invisible on a phone,
                      and what a person needs before this tap is where the row
                      goes (the queue, not a session), WHERE it runs when it
                      gets there, what is not wiped (the failure stays) and what
                      the button NEXT TO IT does instead.
                      Drawn without the online gate, because the verb is.
                      The sentence is worded OFF THE ROW — it promised "a new
                      session of its own" on rows that name a session and will
                      run in that one. */}
                  {runAgainOffered(it) && (
                    <span className="bl-smart-note">{runAgainRowNote(it)}</span>
                  )}
                  {/* **What `fire`/`re-fire` skip — as text.** Drawn where the
                      skip can hurt (another item is running in this checkout,
                      so the tap ASKS) and on a settled row with no other note
                      (`runAgainRowNote` already names `re-fire` on the rest).
                      On an ordinary queued row it is the hint card's, not one
                      identical line under every item in the list. */}
                  {p.online && it.status !== "running" && (fireIntoBusy(it) || (it.status === "done" && !runAgainOffered(it))) && (
                    <span className="bl-smart-note">{skipQueueNote(!it.targetSessionId)}</span>
                  )}
                  {/* …and the row this verb REFUSES: aimed at a session that
                      closed. `Unavailable.tsx`'s rule — the button is simply
                      not drawn and the reason is a sentence, never a dimmed
                      control with its reason in a title. It names the two edits
                      that end the state, because a refusal with no way out is
                      the dead end the rule exists to prevent. */}
                  {runAgainHeld(it) && (
                    <span className="bl-smart-note">{runAgainClosedNote()}</span>
                  )}
                  {/* **A row that has already been put back says so.** Revived,
                      it is otherwise indistinguishable from one that was never
                      in trouble — and the failure it had is gone from `error`
                      the moment it runs again, so without this the reason
                      somebody had to think twice disappears exactly when they
                      are deciding whether to think twice again. The sentence is
                      worded per state in `backlogFilter.ts`. */}
                  {it.requeued && (
                    <span className="bl-smart-note">{requeuedWords(it.requeued, it.status, now)}</span>
                  )}
                  {/* **Whose title that is** — as visible text, and only once
                      the row is open.
                      A title is the one string here a machine wrote over words
                      a person wrote, so who wrote it is not a tooltip's
                      business (`Unavailable.tsx`'s rule: a `title` is invisible
                      on a phone). It is not on every closed row either: down
                      fifty-two rows it would be fifty-two copies of one fact,
                      and the `Sparkles` mark on the line above already says a
                      machine is speaking. Expanded is where a person is
                      deciding about THIS row, which is when whose words these
                      are becomes the question. */}
                  {openText.has(it.id) && it.headline && it.headlineBy && (
                    <span className="bl-smart-note">{HEADLINE_BY_WORDS[it.headlineBy]}</span>
                  )}
                  {it.status === "failed" && it.error && <span className="bl-error">{it.error}</span>}
                  {/* Why this one is still sitting here. A queued row looks the
                      same whether the backlog is waiting exactly as designed or
                      is stuck on something only the host can see (auto off, no
                      session open, the agent mid-turn), and from the phone those
                      are indistinguishable — the same gap `pulls.whyIdle()`
                      closes for downloads. Online only: see the prop. */}
                  {p.online && it.status === "queued" && p.waiting?.[it.id]
                    && !(slotHeld(p.waiting[it.id], p.autoSlots) && slotSessions.length > 0) && (
                    /* Actionable where there is an action: the row is aimed at a
                       session that EXISTS and the sentence is about that
                       session, so the tap has somewhere to go. Every other
                       reason — waiting for a free slot, one at a time in this
                       repo, the desktop is busy — is a WAIT with nothing to
                       press, and a button that changes nothing is worse than
                       none. */
                    /* Gated on the session being ALIVE, not on the sentence's
                       words. The old test matched `/that session/`, and the
                       sentence a row aimed at a CLOSED session wears is *"that
                       session is gone — aim it at another session…"* — so every
                       such row drew its own obituary as an underlined button,
                       whose handler looked the dead id up in the session list,
                       found nothing, and did nothing at all. The one answer
                       this app refuses, produced by the gate meant to prevent
                       it. The regex stays only as a secondary filter, over the
                       sentences that actually name the session a tap goes to. */
                    targetLive(it) && /that session/i.test(p.waiting[it.id])
                      ? <button className="bl-waiting bl-waiting-act" onClick={() => p.nav.onOpenSession(it.targetSessionId!)}
                          title="go to the session this one is aimed at">
                          {p.waiting[it.id]}
                        </button>
                      : <span className="bl-waiting">{p.waiting[it.id]}</span>
                  )}
                  {/* **Held for a slot: offer the room, never take it.** Every
                      automatic slot is held by a session that is WORKING;
                      closing one is a person's tap on the ordinary close. The count IS
                      the list the tap opens (`autoSlotSessions`). */}
                  {p.online && it.status === "queued" && slotHeld(p.waiting?.[it.id], p.autoSlots) && slotSessions.length > 0 && (
                    <div className="bl-slots">
                      <Button className={`bl-step${slotOpen.has(it.id) ? " active" : ""}`}
                        onClick={() => setSlotOpen((m) => toggled(m, it.id))}>
                        <DoorClosed size={14} /> {closeOneLabel(slotSessions.length)}
                      </Button>
                      {slotOpen.has(it.id) && (
                        <ul className="bl-slot-list">
                          {slotSessions.map(({ s, closeWhenDone }) => (
                            <li key={s.id} className="bl-slot">
                              <button className="bl-slot-open" onClick={() => p.nav.onOpenSession(s.id)}>
                                <span className="bl-slot-title">{s.title}</span>
                                <span className="bl-slot-sub">opened {ago(s.createdAt)} · {slotSessionState(s, closeWhenDone)}</span>
                              </button>
                              <Button variant="danger" onClick={() => { track("action:backlog.slotClose"); p.nav.onCloseSession(s); }}>
                                <X size={14} /> close
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                  {/* **Its session once the work is done** — the effective
                      answer first, then the three-way choice. Only on an open
                      row (a decision about THIS item) and only where the row
                      opens a session of its own. */}
                  {openText.has(it.id) && opensOwnSession(it) && (
                    <div className="bl-close-choice">
                      <span className="bl-smart-note">{closeEffectWords(it.closeWhenDone, p.closeWhenDoneGlobal)}</span>
                      {p.online ? (
                        <RadioRows
                          label="when this item is done"
                          options={CLOSE_CHOICES.map((c) => ({ key: c, label: closeChoiceLabel(c, p.closeWhenDoneGlobal) }))}
                          value={closeChoiceOf(it.closeWhenDone)}
                          onChange={(c) => p.verbs.onSetCloseWhenDone(it.id, c)} />
                      ) : (
                        <span className="bl-waiting">Changing it needs the desktop — the link is down.</span>
                      )}
                      {p.online && <RowFlagChoice on={!!it.flagWhenDone} onSet={(on) => p.verbs.onSetFlagWhenDone(it.id, on)} />}
                      {/* No cap yet: the `budget…` chip lives in the expanded row, so an
                          unset row carries no extra chip in the list. Same words as the
                          Send sheet's. A set cap is the chip in the meta line. */}
                      {p.online && budgetEditable(it) && !it.budget && (
                        <div className="bl-close-chips">
                          <button className={`key${m.budgetOpen.has(it.id) ? " active" : ""}`} aria-pressed={m.budgetOpen.has(it.id)}
                            onClick={() => m.toggleBudget(it.id)}><Wallet size={13} /> budget…</button>
                        </div>
                      )}
                    </div>
                  )}
                  {/* The cap's editor — the one `BudgetField`, opened from either chip. */}
                  {budgetEditable(it) && m.budgetOpen.has(it.id) && (
                    <RowBudgetEdit key={`${it.id}:${it.budget ? `${it.budget.unit}${it.budget.max}${it.budget.interrupt}` : "none"}`}
                      current={it.budget} online={p.online}
                      onSet={(b) => { p.verbs.onSetBudget(it.id, b); m.toggleBudget(it.id); }} />
                  )}
                  {openText.has(it.id) && (
                    <div className="bl-check-detail">
                      <div className="bl-steps">
                        {p.online && (
<Button className="bl-step" title="open/resume a session seeded with this task as context" onClick={() => p.verbs.onContinue(it.id)}>
<ArrowRight size={14} /> Continue in a session
</Button>)}
                      </div>
                    </div>
                  )}
                  {it.checkStatus && (() => {
                    const hasDetail = it.checkStatus !== "checking" && !!it.checkDetail;
                    const shown = openDetail.has(it.id);
                    const Tag = hasDetail ? "button" : "span";
                    return (
                      <>
                        <Tag
                          className={`bl-check bl-check-${it.checkStatus}`}
                          title={hasDetail ? "tap for full check details" : it.checkNote || ""}
                          onClick={hasDetail ? () => toggleDetail(it.id) : undefined}
                        >
                          {(() => { const I = CHECK_ICON[it.checkStatus]; return <I size={12} style={{ verticalAlign: "-2px" }} />; })()}{" "}
                          {CHECK_LABEL[it.checkStatus]}{it.checkNote ? ` · ${it.checkNote}` : ""}
                          {hasDetail ? (shown ? <ChevronDown size={12} style={{ verticalAlign: "-2px" }} /> : <ChevronRight size={12} style={{ verticalAlign: "-2px" }} />) : null}
                        </Tag>
                        {hasDetail && shown && (
                          <div className="bl-check-detail">
                            <pre>{it.checkDetail}</pre>
                            <div className="bl-steps">
                              {p.online && (
<Button className="bl-step" title="open/resume a session with this task + verdict as context" onClick={() => p.verbs.onContinue(it.id)}>
<ArrowRight size={14} /> Continue in a session
</Button>)}
                            </div>
                            {it.checkedAt && <span className="bl-check-when">checked {new Date(it.checkedAt).toLocaleString()}</span>}
                          </div>
                        )}
                      </>
                    );
                  })()}
                  {it.validateStatus && (() => {
                    const hasDetail = it.validateStatus !== "validating" && (!!it.validateDetail || !!it.validateSteps?.length);
                    const shown = openValidate.has(it.id);
                    const Tag = hasDetail ? "button" : "span";
                    return (
                      <>
                        <Tag
                          className={`bl-check bl-validate-${it.validateStatus}`}
                          title={hasDetail ? "tap for validation details & next steps" : it.validateNote || ""}
                          onClick={hasDetail ? () => toggleValidate(it.id) : undefined}
                        >
                          {(() => { const I = VALIDATE_ICON[it.validateStatus]; return <I size={12} style={{ verticalAlign: "-2px" }} />; })()}{" "}
                          {VALIDATE_LABEL[it.validateStatus]}{it.validateNote ? ` · ${it.validateNote}` : ""}
                          {hasDetail ? (shown ? <ChevronDown size={12} style={{ verticalAlign: "-2px" }} /> : <ChevronRight size={12} style={{ verticalAlign: "-2px" }} />) : null}
                        </Tag>
                        {hasDetail && shown && (
                          <div className="bl-check-detail">
                            {it.validateDetail && <pre>{it.validateDetail}</pre>}
                            {!!it.validateSteps?.length && (
                              <div className="bl-steps">
                                <span className="bl-steps-head">Next steps — tap to run in the CLI:</span>
                                {it.validateSteps.map((s, si) => (
                                  p.online && (<Button key={si} className="bl-step" title={s.prompt} onClick={() => p.verbs.onNextStep(it.id, si)}>
                                    <ArrowRight size={14} /> {s.label}
                                  </Button>)
                                ))}
                              </div>
                            )}
                            <div className="bl-steps">
                              {p.online && (
<Button className="bl-step" title="open/resume a session with this task + verdict as context" onClick={() => p.verbs.onContinue(it.id)}>
<ArrowRight size={14} /> Continue in a session
</Button>)}
                            </div>
                            {it.validatedAt && <span className="bl-check-when">validated {new Date(it.validatedAt).toLocaleString()}</span>}
                          </div>
                        )}
                      </>
                    );
                  })()}
    </>
  );
}
