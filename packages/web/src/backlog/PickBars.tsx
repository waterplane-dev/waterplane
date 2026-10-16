/**
 * The pick list (re-time many, one clock at a time or by ticks) and the naming
 * tap: the two light verbs, on one line, ABOVE the list in both orders.
 *
 * A REGION of the backlog sheet: no hooks of its own (a child's effects run
 * before its parent's, so a hook here would reorder them), only the model.
 * Shape: docs/notes/backlog-architecture.md.
 */
import { BellRing, CalendarClock, ClipboardCheck, ListChecks, Sparkles } from "lucide-react";
import { Explain } from "../Explain";
import { NAME_COST_NOTE, NAME_RUNNING_NOTE, RETIME_PICK_LABEL, clockPickLabel, nameLabel, nameNote } from "../backlogFilter";
import { RetimeBar, RetimeLayer } from "../RetimeBar";
import { SLOT_ASK_ON_LABEL, SLOT_ASK_ON_TITLE, slotAskOnToast, slotCheckLabel, slotCheckTitle } from "../slotCheck";
import { setSlotAskOff } from "../slotAskStore";
import { showToast } from "../toast";
import { baseName } from "../format";
import { track } from "../usage";
import { Unavailable } from "../Unavailable";
import type { BacklogModel } from "./backlogTypes";

/**
 * **The pick list and the naming tap — ABOVE the list, in both orders.** In an
 * ids cut the other bars follow the rows on purpose, and this one used to go
 * with them: thirty-one rows down, so "move all of these past the reset" had
 * no visible way to start. While picking, the bar is sticky (`.bl-pick-bar`):
 * the tick on row 25 and the button that sends it are on one screen.
 */
export function PickBars({ m }: { m: BacklogModel }) {
  const {
    choosing, cut, displayOrder, nameIds, namingHere, p, picking, repoDir, retimeable, retimeClocks, retimeIds,
    setChoosing, setPicked, setPicking, slotCheckList, slotAskOff, now,
  } = m;
  /** The slot check, one verb per slot with ≥2 waiting rows — live-only, like
   *  every bulk verb here; `slotAskOff`'s way back only where it is off. */
  const showSlot = p.online && !picking && !!p.cutVerbs.onSlotCheck && slotCheckList.length > 0;
  const showAskOn = p.online && slotAskOff;
  const showPick = p.online && !picking && retimeable.length > 1;
  /** Tick exactly one clock's movable rows and open the pick list on them. */
  const pickClock = (ids: string[]) => { track("action:backlog.retime.clock"); setPicked(new Set(ids)); setPicking(true); };
  const showName = nameIds.length > 0 && p.online;
  return (
    <>
      {/* **The two verbs always on offer, on one line** (they were a row each).

          **Re-time many at once.** A pick list over the rows ON SCREEN, one new
          instant, one tap, one receipt. Every per-row path to a new time is the
          Send sheet, one row at a time; eight rows waiting for the same reset
          that should all move to tomorrow morning was eight trips through it.

          The count on the button IS the ticked-and-eligible set on screen
          (`retimeIds`), rows that cannot move draw no box and the note says so
          in text, and with nothing ticked or a time already gone the button is
          ABSENT and a sentence stands where it would be — never a dimmed one.
          Live-only like every bulk bar here: a clock decision replayed an hour
          late is about an instant that may have arrived.

          **The tap that asks for titles and kinds.**
          A hand-written row has neither, and nothing in this app derives one
          for it — so a repo's list is fifty-two first-lines-of-prose and the
          kind chips a line above have nothing to count. This is the only verb
          here that is not behind a `ConfirmButton`, and deliberately: naming
          destroys nothing, never writes over a name somebody typed, and any of
          them is one tap to edit or clear on its own row. A confirm on a
          harmless button is what teaches people to tap through the ones that
          matter.

          Drawn only while the link is up: this sheet's own offline line, above,
          already says every mutation here waits for the connection, and a
          second copy of it under every bulk bar is four sentences for one fact.
          While a pass is running the button is ABSENT and the sentence says why
          — never a dimmed copy of itself, whose reason on a phone lives
          nowhere. */}
      {(showPick || showName || showSlot || showAskOn) && (
        <div className="bl-bulk">
          {showPick && (
            <button className="link-btn" title="tick several rows and move them all to one new time"
              onClick={() => { track("action:backlog.retime.pick"); setPicking(true); }}>
              <ListChecks size={14} /> {RETIME_PICK_LABEL}
            </button>
          )}
          {/* **One clock, one tap.** Twenty rows waiting for the same reset
              are one decision — "move them past it" — and were twenty ticks.
              The count is exactly what the tap ticks (`clockPicks`); the When
              editor still opens from the bar, so nothing moves on this tap. */}
          {showPick && retimeClocks.map((c) => (
            <button key={c.key} className="link-btn"
              title="tick every row on this clock — then choose their new when"
              onClick={() => pickClock(c.ids)}>
              <CalendarClock size={14} /> {clockPickLabel(c)}
            </button>
          ))}
          {/* **Rows that fire together, checked together.** The count is
              exactly the ids the run reads (`slotChecks`) — and that cut is
              what the sheet it opens is about. Agent-posted rows land here
              with nobody there to ask; this is where they are checked. */}
          {showSlot && slotCheckList.map((c) => (
            <button key={c.scope.key} className="link-btn" title={slotCheckTitle(c)}
              onClick={() => { track("action:backlog.slotcheck"); p.cutVerbs.onSlotCheck?.(c); }}>
              <ClipboardCheck size={14} /> {slotCheckLabel(c, now)}
            </button>
          ))}
          {/* The one way back from *don't ask in this repo* — and the toast
              that switched it off names this label. */}
          {showAskOn && (
            <button className="link-btn" title={SLOT_ASK_ON_TITLE}
              onClick={() => { track("action:backlog.slotask.on"); setSlotAskOff(repoDir, false); showToast(slotAskOnToast(baseName(repoDir))); }}>
              <BellRing size={14} /> {SLOT_ASK_ON_LABEL}
            </button>
          )}
          {showName && (namingHere ? (
            <Unavailable cants={[{ label: nameLabel(nameIds.length), reason: NAME_RUNNING_NOTE }]} />
          ) : (
            <>
              <button className="link-btn" data-hint="backlog.name"
                title={nameNote(nameIds.length, cut.length)}
                onClick={() => { track("action:backlog.name"); p.cutVerbs.onName(repoDir, nameIds); }}>
                <Sparkles size={14} /> {nameLabel(nameIds.length)}
              </button>
              {/* What it does and SPENDS, one tap away beside the button. */}
              <Explain of="naming">
                {nameNote(nameIds.length, cut.length)}
                <div className="bl-cost">{NAME_COST_NOTE}</div>
              </Explain>
            </>
          ))}
        </div>
      )}
      {p.online && picking && (
        <div className="bl-pick-bar"><RetimeBar picked={retimeIds.length} eligible={retimeable.length} shown={displayOrder.length}
          where="backlog"
          onAll={() => setPicked(new Set(retimeable.map((it) => it.id)))}
          onNone={() => setPicked(new Set())}
          onDone={() => { setPicking(false); setPicked(new Set()); }}
          onChoose={() => setChoosing(true)} /></div>
      )}
      {choosing && retimeIds.length > 0 && (
        <RetimeLayer>{p.nav.renderRetime(retimeIds, {
          onSent: () => { setChoosing(false); setPicking(false); setPicked(new Set()); },
          onCancel: () => setChoosing(false),
        })}</RetimeLayer>
      )}
    </>
  );
}
