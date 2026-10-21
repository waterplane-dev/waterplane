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
import { useState } from "react";
import { Gauge, Hourglass, ListOrdered, ListTodo, Pencil, X, Zap } from "lucide-react";
import type { NextPromptView } from "./nextPromptState";
import { pastBudgetLabel, skipQueueNote } from "./sendIntent";
import { Stowable, StowButton } from "./Stowable";
import { PromptComposer } from "./PromptComposer";
import { Button } from "./kit/Button";
import { Row } from "./kit/Row";
import { Hint } from "./kit/Hint";

const ICON = 14;

export function NextPrompt({ view, onSendNow, onPastBudget, onHold, onOpenQueue, onOpenBacklog, keepFocus, editableText, onEdit, onCancel }: {
  view: NextPromptView | null;
  /** The full words of a row that can still be rewritten, or null — no pencil
   *  is drawn for a row that cannot be (a sent one, an answer keystroke, a
   *  desktop row with no link). */
  editableText: (id: string, holder: "phone" | "desktop") => string | null;
  /** Save a rewrite. `true` when the words landed somewhere (the row, or the
   *  pad if the row went in meanwhile) and the editor may close; `false` keeps
   *  it open over the words — the caller has said why. */
  onEdit: (id: string, holder: "phone" | "desktop", text: string) => boolean;
  /** Take the row out of line so it never goes in. Drawn only where the row
   *  can still be rewritten (the same test as the pencil); the caller keeps
   *  the words on the pad before the row goes. */
  onCancel: (id: string, holder: "phone" | "desktop") => void;
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
  // The editor is keyed by the row it OPENED on, not by whatever the strip
  // shows now: if that row goes in mid-edit, Save still reaches it and the
  // caller rescues the words to the pad instead of this closing over them.
  const [editing, setEditing] = useState<{ id: string; holder: "phone" | "desktop"; text: string } | null>(null);
  if (editing) {
    const save = () => {
      const text = editing.text.trim();
      if (!text) return;
      if (onEdit(editing.id, editing.holder, text)) setEditing(null);
    };
    return (
      <div className="nextp nextp-editing">
        <div className="form" style={{ width: "100%" }}>
          <PromptComposer inline rows={3} prompts={[editing.text]} autoFocus
            onChange={(next) => setEditing({ ...editing, text: next[0] ?? "" })} placeholder="the next prompt…" />
          {!editing.text.trim() && <Hint>Nothing to save — type the prompt, or cancel to keep it as it was.</Hint>}
          <Row>
            {editing.text.trim() && <button className="send" onClick={save}>Save</button>}
            <Button onClick={() => setEditing(null)}>Cancel</Button>
          </Row>
        </div>
      </div>
    );
  }
  if (!view) return null;
  const editText = editableText(view.id, view.holder);
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
              <Button data-hint="queue.sendnow" onPointerDown={keepFocus}
                title={skipQueueNote(false)}
                onClick={() => onSendNow(view.id, view.holder)}><Zap size={ICON} /> send now</Button>
              {/* The budget is the wait, not the turn: lift that one rung for
                  this row and leave *when it's free* standing. */}
              {view.budgetHeld && (
                <Button onPointerDown={keepFocus}
                  title="lifts the usage budget for this prompt only — it still goes in when this session is free"
                  onClick={() => onPastBudget(view.id)}><Gauge size={ICON} /> {pastBudgetLabel(1)}</Button>
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
        <Button data-hint="queue.hold" onPointerDown={keepFocus}
          title="hand it to the desktop and let it go in when this session is free, instead of typing it in mid-turn"
          onClick={() => onHold(view.id)}><Hourglass size={ICON} /> when it&apos;s free</Button>
      )}
      {/* Rewrite it while it has not gone in yet. Absent, not dimmed, on a row
          that cannot be rewritten. */}
      {editText != null && (
        <Button onPointerDown={keepFocus} title="rewrite this prompt before it goes in"
          onClick={() => setEditing({ id: view.id, holder: view.holder, text: editText })}><Pencil size={ICON} /> edit</Button>
      )}
      {editText != null && (
        <Button onPointerDown={keepFocus} title="don't send it — the words are kept on the pad"
          onClick={() => onCancel(view.id, view.holder)}><X size={ICON} /> cancel</Button>
      )}
      {/* Where the rest of them are — and they are in two different places, so
          the button goes to the one this row actually came out of. The phone's
          queue is every session's transport; the backlog is this repo's waiting
          work, which is where a pinned item lives and is the only list that can
          reorder or cancel one. */}
      {view.holder === "desktop" ? (
        <Button onPointerDown={keepFocus} title="this repo's waiting work on the desktop"
          onClick={onOpenBacklog}><ListTodo size={ICON} /> backlog</Button>
      ) : (
        <Button onPointerDown={keepFocus} title="the whole queue for every session"
          onClick={onOpenQueue}><ListOrdered size={ICON} /> queue</Button>
      )}
      <StowButton className="key" />
    </div>
    </Stowable>
  );
}
