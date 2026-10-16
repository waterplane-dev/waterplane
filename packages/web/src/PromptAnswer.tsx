import { Bot, CloudOff, ScrollText } from "lucide-react";
import type { AnswerSuggestion, DetectedPrompt } from "@waterplane/shared";
import { copyText } from "./api";
import { Markdown } from "./Markdown";
import { showToast } from "./toast";
import { track } from "./usage";
import { remembersText, suggestionBy } from "./suggestionBy";

interface Props {
  /** The box, as the host published it (`prompt.ts` + `askbox.ts`). */
  prompt: DetectedPrompt;
  /**
   * Answers already queued for THIS box — matched on the fingerprint by the
   * caller, never on the session: one left over from a box that has since been
   * replaced is not this one's. A LIST because a checkbox box legitimately
   * collects several (toggle, toggle, Submit).
   */
  queued: readonly { label: string }[];
  /** A plugin's suggested answer (`plugin.ts`). A person still taps. */
  suggestion?: AnswerSuggestion | null;
  /** App's `answerPrompt`, bound to the session this card is about. */
  onAnswer: (data: string, label: string, submitBox?: boolean, choice?: number) => void;
  /** Usage-counter prefix — which surface this card is (`prompt` / `questions`). */
  ev: string;
}

/**
 * **The one place a choice box is answered by tapping.**
 *
 * There used to be two, and then the second one stopped earning its place. The
 * session screen carried an `approve` BAR under the terminal — its own card, its
 * own three sizes, its own standing collapse preference — and it took its height
 * FROM the terminal, which is what every rendering rule on it was compensating
 * for: a `vh` cap, a three-line clamp on the descriptions, a `more` toggle, a
 * minimize handle and a hide handle. The bill for that came due on a six-option
 * `AskUserQuestion` with a paragraph each: two options visible, four inside a
 * scroll region with no scrollbar on Android, nothing saying they existed — the
 * report that started this ("it is buggy anyway as it does not show all
 * options"). Meanwhile the READER was drawing the same question, all six
 * options, unclamped, in a document with its own scroll — and they were spans.
 * The one surface that had room could not answer; the one that could had no
 * room.
 *
 * In the terminal view the bar had no argument left either: the CLI is drawing
 * that box, with the same options and the same descriptions, inches above a card
 * restating them — and a terminal is driven the terminal's way, by pressing the
 * digit (`cliKeys.ts`, the special-key row). So the bar is gone, and this is
 * what took its place: the card body shared by the READER's `tr-ask` and the
 * `QuestionsSheet`, the two surfaces that have a scroll of their own and are
 * therefore allowed to show the whole question. One exception draws it over the
 * terminal too: the workspace-trust box (`core/session/termAnswers.ts`), the first
 * box a new person meets, before they know the key bar, unnumbered so no digit works.
 *
 * Nothing about WHAT an answer is changed: every tap goes through App's
 * `answerPrompt`, which queues it durably, fingerprinted and first-in-lane, and
 * the host refuses it if the box it names has gone. No new send path.
 */
export function PromptAnswer({ prompt: p, queued, suggestion, onAnswer, ev }: Props) {
  // Options carrying the CLI's own descriptions (host `askbox.ts`) go one per
  // row: a chip grid is right for "1. Yes / 2. No" and useless for a paragraph.
  // `open` (nothing clamped) is unconditional here — both callers are scrolling
  // documents, and a label with its explanation nowhere on the device is a
  // button you cannot honestly press, which is the whole point of the
  // enrichment.
  const rich = p.options.some((o) => o.desc);
  const submitWord = p.submitLabel ?? "Submit";
  return (
    <>
      {/* The CLI's own question where the host could read it out of the
          conversation log; the scraped one is whatever fit above option 1. */}
      {p.plan && <PlanBody plan={p.plan} />}
      <div className="approve-q">{p.ask || p.question}</div>
      {p.truncated && (
        // Not cosmetic: options exist that cannot be tapped. Two shapes, two
        // sentences, because they are cut in two different directions — a
        // claude box is TALLER than the terminal and loses the options ABOVE
        // this one, while a `nav` box draws its options on a single row and
        // loses the ones off the RIGHT-HAND EDGE on a narrow grid.
        <div className="approve-hint">
          {p.nav
            ? "the options run off the side of the terminal — the ones past the edge are not here"
            : `the box is taller than the screen — options above ${p.options[0].index} are off it`}
          {p.ask ? "" : "; open the CLI to see them"}
        </div>
      )}
      {p.multi && (
        // What the commit button DOES, in words. `submitLabel` is the word the
        // TUI drew on its own row, and on every question of a multi-question
        // ask but the last that word is "Next" — Return there moves to the
        // following question instead of answering. A `title` cannot say so: it
        // is invisible on a phone (`Unavailable.tsx`'s rule).
        <div className="approve-hint">
          {p.submitLabel === "Next"
            ? "multi-select — tap options to toggle, then Next. This ask has more questions: Next moves to the following one."
            : "multi-select — tap options to toggle, then Submit"}
        </div>
      )}
      {queued.length > 0 && (
        <div className="approve-hint approve-queued">
          <CloudOff size={12} style={{ verticalAlign: "-2px" }} />{" "}
          {queued.length > 1
            ? `${queued.length} answers queued (${queued.map((e) => e.label).join(", ")})`
            : `“${queued[0].label}” queued`} — sent, in order, as soon as the link is back
        </div>
      )}
      {suggestion?.choice != null && (
        <div className="oracle-hint" title={`${suggestionBy(suggestion)} · ${(suggestion.confidence * 100).toFixed(0)}% sure`}>
          <Bot size={13} style={{ verticalAlign: "-2px" }} /> {suggestionBy(suggestion)} suggests <b>{suggestion.choice}</b>: {suggestion.rationale}
        </div>
      )}
      <div className={`approve-opts${rich ? " rich open" : ""}`}>
        {p.options.map((o) => {
          const suggested = suggestion?.choice === o.index;
          return (
            <button
              key={o.index}
              // Option 1 is the CLI's own first choice on a numbered box ("Yes"); a `nav` box keeps
              // no such order — claude 2.1.293's trust box lists "No, exit" first — so none is primary.
              className={`approve-btn ${o.index === 1 && !p.multi && !p.nav ? "primary" : ""} ${suggested ? "suggested" : ""}`}
              // A checkbox box answers on Submit: a digit there only TOGGLES the
              // row, so appending Return would submit whatever is ticked at that
              // moment (usually the wrong set).
              //
              // A `nav` box has no digits AT ALL — its options are words on one
              // row and the only thing that decides what Return does is which one
              // the TUI has armed. So nothing is typed: the entry names the
              // option and the host walks the selection there (`promptChoice`).
              // The index is this list's own numbering, which is why it is not
              // printed on the button: "2." beside an option the terminal never
              // numbered would teach the one keystroke that does not work here.
              onClick={() => {
                track(`action:${ev}.answer`);
                if (p.nav) onAnswer("", o.label, undefined, o.index);
                else onAnswer(String(o.index) + (p.multi ? "" : "\r"), `${o.index}. ${o.label}`);
              }}
            >
              <span className="approve-lbl">
                {suggested ? <Bot size={13} style={{ verticalAlign: "-2px", marginRight: 3 }} /> : null}{p.nav ? "" : `${o.index}. `}{o.label}
              </span>
              {o.desc && <span className="approve-desc">{o.desc}</span>}
              {/* A tap here makes a standing rule (host `answergate.ts`): said on the
                  option, in the host's own label, before anyone taps it. */}
              {o.remembers && <span className="approve-desc approve-remembers">{remembersText(o.remembers)}</span>}
            </button>
          );
        })}
      </div>
      {/* The commit row, never inside the option list: on a multi-select Submit
          is the only control that answers anything, and a commit button you have
          to find by scrolling past six options is a commit button that gets
          missed. */}
      <div className="approve-commit">
        {p.multi && (
          // The Return that confirms a checkbox box only means "submit" on the
          // box's own Submit ROW — pressed on option 1, where the cursor starts,
          // it re-toggles that option and the box stays open. The cursor is
          // walked there host-side (`promptSubmit`); the client has no idea
          // where it is.
          <button
            className="approve-btn primary"
            onClick={() => { track(`action:${ev}.submit`); onAnswer("\r", submitWord, true); }}
          >{submitWord} ⏎</button>
        )}
        <button className="approve-esc" onClick={() => { track(`action:${ev}.esc`); onAnswer("\x1b", "Esc"); }}>Esc</button>
      </div>
    </>
  );
}

/**
 * The plan a plan-approval box asks about (host `planbox.ts`): the CLI draws it
 * ABOVE the box, so on the terminal it has scrolled away long before anyone
 * reaches the buttons, and the log does not hold it until the box is answered.
 * Open by default — it is the thing being approved — and foldable, because a
 * long plan otherwise puts the buttons a whole document below the question.
 */
function PlanBody({ plan }: { plan: NonNullable<DetectedPrompt["plan"]> }) {
  const copy = (text: string) => void copyText(text).then((ok) => showToast(ok ? "copied" : "copy failed"));
  const lines = plan.text.split("\n").length;
  return (
    <details className="approve-plan" open>
      <summary>
        <ScrollText size={13} style={{ verticalAlign: "-2px" }} /> the plan · {lines} lines
      </summary>
      <div className="approve-plan-body">
        <Markdown src={plan.text} q="" onCopy={copy} />
      </div>
      <div className="approve-hint">
        {plan.cut ? "longer than the host sends — the rest is in " : "from "}{plan.path.replace(/^\/(Users|home)\/[^/]+/, "~")}
      </div>
    </details>
  );
}
