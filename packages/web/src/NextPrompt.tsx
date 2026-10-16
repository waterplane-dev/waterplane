/**
 * **"What goes in after this" — beside the turn you are watching.**
 *
 * The decision is `nextPromptState.ts`'s and tested there; this draws it and owns
 * nothing. Three rules shape what is on screen:
 *
 *  - **The words, not a count.** The queue bar under this already says "3
 *    queued" about the whole queue. What a person needs in order to decide
 *    whether to let it wait is which prompt it is, in their own words.
 *  - **One verb, and it is the one that is not the current state.** A parked
 *    entry offers *send now*; an un-parked one offers *when it's free* — the
 *    composer's own words for the same decision, not a fourth spelling of it.
 *    Two buttons where one is always a no-op is how a strip this small stops
 *    being read.
 *  - **A refusal is a sentence.** With a dialog open or a limit block in that
 *    session, *send now* would type prose into a menu — so the button is not
 *    rendered at all and the wall says itself (`Unavailable.tsx`'s rule; a
 *    dimmed button is indistinguishable from a live one on a phone and its
 *    `title` is invisible).
 *
 * It sits directly above the queue bar and the composer, so it is on screen in
 * BOTH views — the terminal, where the CLI draws its own spinner, and the
 * reader, whose working line is its own strip. One mount, because the session
 * screen is one screen with two faces.
 */
import { Gauge, Hourglass, ListOrdered, ListTodo, Zap } from "lucide-react";
import type { NextPromptView } from "./nextPromptState";
import { pastBudgetLabel, skipQueueNote } from "./sendIntent";
import { Stowable, StowButton } from "./Stowable";

const ICON = 14;

export function NextPrompt({ view, onSendNow, onPastBudget, onHold, onOpenQueue, onOpenBacklog, keepFocus }: {
  view: NextPromptView | null;
  /** The phone's ackId or the desktop's item id — `view.holder` says which. */
  onSendNow: (id: string, holder: "phone" | "desktop") => void;
  /** *let it past the budget* on a desktop-held row the budget holds
   *  (`view.budgetHeld`): `intent.waive` for that row id. */
  onPastBudget: (id: string) => void;
  /**
   * *when it's free* on a phone-held entry. App decides which machine ends up
   * holding it: a live session's entry is re-aimed into the DESKTOP's queue
   * (`handToDesktop`), and only a session that does not exist yet keeps the
   * phone's own park — a wait this tab serves is a promise about a screen that
   * may be locked.
   */
  onHold: (ackId: string) => void;
  onOpenQueue: () => void;
  /** The desktop's queue for this repo, which is where a pinned item lives. */
  onOpenBacklog: () => void;
  /** `preventDefault` on pointer-down, so a tap here does not blur the compose
   *  box and dismiss the keyboard mid-thought — the same guard every other
   *  button on this bar takes. */
  keepFocus: (e: React.PointerEvent) => void;
}) {
  if (!view) return null;
  return (
    // Folded for THIS entry: the next one in line is a new decision and shows.
    <Stowable slot="next-prompt" stowKey={`${view.holder}:${view.id}`} label="next prompt"
      detail={view.behind > 0 ? `+${view.behind}` : undefined} icon={view.held ? Hourglass : Zap}>
    <div className={`nextp${view.held ? " nextp-held" : ""}`}>
      <span className="nextp-mark">{view.held ? <Hourglass size={ICON} /> : <Zap size={ICON} />}</span>
      <span className="nextp-body">
        <span className="nextp-words">next: {view.words}</span>
        {view.tie && <span className="nextp-why nextp-tie">{view.tie}</span>}
        <span className="nextp-why">
          {view.why}
          {view.behind > 0 ? ` · ${view.behind} more behind it` : ""}
        </span>
        {/* What *send now* skips, as text beside it — the one promise every
            single-row skip-the-queue verb makes (`skipQueueNote`). Only where
            the button is drawn. */}
        {view.held && !view.wall && <span className="nextp-why">{skipQueueNote(false)}</span>}
        {/* The milder verb's promise, beside it: only the budget is lifted. */}
        {view.budgetHeld && !view.wall && <span className="nextp-why">past the budget: it still waits for this turn to end</span>}
      </span>
      {view.held ? (
        view.wall
          // Not a disabled button. The sentence IS the control's absence.
          ? <span className="nextp-cant">{view.wall}</span>
          : <>
              <button className="key" data-hint="queue.sendnow" onPointerDown={keepFocus}
                title={skipQueueNote(false)}
                onClick={() => onSendNow(view.id, view.holder)}><Zap size={ICON} /> send now</button>
              {/* The budget is the wait, not the turn: lift that one rung for
                  this row and leave *when it's free* standing. */}
              {view.budgetHeld && (
                <button className="key" onPointerDown={keepFocus}
                  title="lifts the usage budget for this prompt only — it still goes in when this session is free"
                  onClick={() => onPastBudget(view.id)}><Gauge size={ICON} /> {pastBudgetLabel(1)}</button>
              )}
            </>
      ) : (
        // Only ever offered on a PHONE-held entry: the park is this tab's, so
        // putting one on is something this tab can do. A desktop-held item is
        // already waiting by construction — there is nothing to toggle — and
        // `view.held` is true for every one of them, so this arm is unreachable
        // for them by the type, not by a check that could drift.
        // ONE name for this WHEN, everywhere it is offered. The composer calls
        // it `When free`, the Backlog row calls it `when <title> is free` and
        // the queue row's hourglass says the same sentence; this button used to
        // call it `make it wait`, which is a fourth spelling of one decision on
        // a strip two taps from the other three.
        <button className="key" data-hint="queue.hold" onPointerDown={keepFocus}
          title="hand it to the desktop and let it go in when this session is free, instead of typing it in mid-turn"
          onClick={() => onHold(view.id)}><Hourglass size={ICON} /> when it&apos;s free</button>
      )}
      {/* Where the rest of them are — and they are in two different places, so
          the button goes to the one this row actually came out of. The phone's
          queue is every session's transport; the backlog is this repo's waiting
          work, which is where a pinned item lives and is the only list that can
          reorder or cancel one. */}
      {view.holder === "desktop" ? (
        <button className="key" onPointerDown={keepFocus} title="this repo's waiting work on the desktop"
          onClick={onOpenBacklog}><ListTodo size={ICON} /> backlog</button>
      ) : (
        <button className="key" onPointerDown={keepFocus} title="the whole queue for every session"
          onClick={onOpenQueue}><ListOrdered size={ICON} /> queue</button>
      )}
      <StowButton className="key" />
    </div>
    </Stowable>
  );
}
