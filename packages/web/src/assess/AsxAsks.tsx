/**
 * The two questions an apply asks, last in the scroll.
 * Part of `AssessSheet.tsx`, the facade every caller imports; map and rules: docs/notes/assess-architecture.md.
 */
import { ASSESS_NAME_SKIP, ASSESS_NAME_WRITE, ASSESS_PIN_FREE, ASSESS_PIN_KEEP, assessNameNote, assessNameQuestion, assessPinNote, assessPinQuestion } from "@waterplane/shared";
import { track } from "../usage";
import { RadioRows } from "../kit";
import type { AssessModel } from "./useAssessSheet";

export function AsxAsks({ m }: { m: AssessModel }) {
  const { rankedN, pinRanks, setPinRanks, nameCount, writeNames, setWriteNames } = m;
  /**
   * **The two things about this apply only a person can decide** — and they are
   * the LAST thing in the scroll, not a band in the fixed footer.
   *
   * They were in the footer, which is where "above the button rather than behind
   * it" put them: a decision hidden behind the tap that performs it is a
   * decision nobody made. That is still the rule, and this still obeys it — the
   * questions sit immediately above the bar that holds Apply, read in order, one
   * scroll position away from it.
   *
   * What changed is what a FIXED band costs. ONE measurement, quoted here and
   * in `.asr-pin` and `web.md` and nowhere re-taken — re-taken TOGETHER when it
   * moves, which it just did. Headless Chrome, both questions drawn: at
   * 320×780 and `--ui-font` 1 the list keeps **399 px** with them in the scroll
   * and the pair is **314 px**; at 400×850, **520 px** and **250 px**. In the
   * fixed footer that height comes straight off the list — the same letterbox
   * the guide block was moved out of the head for, rebuilt at the other end of
   * the screen. The footer is the one part of this sheet that cannot scroll
   * away, so what lives there has to be true at every scroll position and cost
   * its height for ever: the apply bar and the sentence saying what applying
   * does not do. A question you answer once is neither.
   *
   * Side by side, for the same arithmetic: the taller of the two governs, so
   * asking a second question costs almost nothing in height (`.asr-asks`) —
   * and the pair drops to ONE column by itself wherever two would be narrower
   * than the words, because the column basis is in `ch` and so scales with
   * `--ui-font`. That is not a nicety: at 384 px with a larger text size the
   * two columns stayed side by side at a width the answers did not fit, and the
   * buttons painted over each other and off the right edge of the screen.
   *
   * **What this placement costs is that they can be scrolled past**, and the
   * price is paid in the footer: `assessApplyLabel` restates BOTH answers, so
   * the last line read before the tap names the decision even when the question
   * was never on screen.
   */
  return (rankedN > 0 || nameCount > 0) ? (
      // **The two things about this apply only a person can decide, side by
      // side.** They are the same shape and the same weight, so they read as
      // two answers to one screen rather than as a warning stacked on a
      // warning — and on a phone the pair wraps to two rows instead of adding
      // a third band of chrome above the only irreversible tap here. Each is
      // drawn only where its question can arise.
      <div className="asr-asks">
        {rankedN > 0 && (
          <div className="form-hint asr-pin">
            {assessPinQuestion(rankedN)}
            {/* `.asr-answer`, never the annotator's `.annot-tools tri` strip it
                borrowed: that class is `overflow: visible` over `.key`s that are
                `flex: 0 0 auto`, i.e. always their max-content width, so at a
                larger `--ui-font` the old free-order label painted straight
                over the question beside it and `leave the rows as they are` ran
                off the right edge of the phone. Reported from a 384 px device
                with a bigger-than-default text size, which is why it was never
                seen at 320 or 400 in a default-scaled browser. */}
            <div className="asr-answer">
              <RadioRows label="the order of the rows" value={pinRanks ? "keep" : "free"}
                options={[{ key: "keep", label: ASSESS_PIN_KEEP }, { key: "free", label: ASSESS_PIN_FREE }]}
                onChange={(k) => { if (k === "keep") { track("action:assess.pin"); setPinRanks(true); } else { track("action:assess.pin.free"); setPinRanks(false); } }} />
            </div>
            <div>{assessPinNote(pinRanks)}</div>
          </div>
        )}
        {/* **Do the run's titles go on the rows?** Above the button rather than
            behind it, for the pin question's reason: it is half of what the tap
            is about to do, and a decision hidden behind the tap that performs
            it is a decision nobody made. Neither answer is styled as the safe
            one — a titled backlog is scannable in a way a wall of first lines
            is not, and a title a model wrote is also the one string on the row
            nobody checked. */}
        {nameCount > 0 && (
          <div className="form-hint asr-pin">
            {assessNameQuestion(nameCount)}
            <div className="asr-answer">
              <RadioRows label="the run's titles" value={writeNames ? "write" : "skip"}
                options={[{ key: "write", label: ASSESS_NAME_WRITE }, { key: "skip", label: ASSESS_NAME_SKIP }]}
                onChange={(k) => { if (k === "write") { track("action:assess.name"); setWriteNames(true); } else { track("action:assess.name.skip"); setWriteNames(false); } }} />
            </div>
            <div>{assessNameNote(writeNames)}</div>
          </div>
        )}
      </div>
  ) : null;
}
