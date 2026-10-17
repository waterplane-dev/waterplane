/** A detected interactive prompt the session is waiting on (Yes/No, etc). */
export interface PromptOption {
  index: number;
  label: string;
  /**
   * The option's own description, as the CLI itself wrote it — NOT scraped.
   *
   * `AskUserQuestion` draws a wrapped description under every label, and the
   * terminal is where those go to die: they are truncated at the right edge, cut
   * by the preview pane, and on a tall box they scroll off entirely. The label
   * alone ("A + B + C") is then a button with no meaning behind it. This comes
   * from the pending tool call in the CLI's own conversation log (host
   * `askbox.ts`), so it is the full text regardless of what fit on screen.
   *
   * Deliberately NOT part of `promptFingerprint`: it changes nothing about what
   * a keystroke MEANS, and enrichment that arrives one check later must not
   * invalidate an answer already queued against the box.
   */
  desc?: string;
  /**
   * Tapping THIS option makes a standing rule (host `answergate.ts`): the plugin that
   * posed the dialog may then answer the same request on this session without a tap,
   * until the session ends, the plugin is switched off or the host restarts. `label` is
   * what the host keeps the rule under — the phone says it on the option, before the tap.
   * Additive (PROTOCOL_VERSION stays 2); outside `promptFingerprint` for `desc`'s reason.
   */
  remembers?: { label: string };
  /**
   * A checkbox box's tick on this row, as the TUI drew it (`[✔]` vs `[ ]`) on the
   * newest strict read. ABSENT means unknown — a single-choice box, or a row the
   * log recovered after the screen scrolled it away — and the phone then draws no
   * box at all rather than an empty one, which would read as "not ticked".
   * Outside `promptFingerprint`: a tap toggles it, and a toggle must not stale the
   * next queued tap or re-open a hidden card.
   */
  checked?: boolean;
}

/** One standing rule, on the wire: what it allows, when a person made it, how often it answered. */
export interface StandingRule { label: string; at: number; uses: number }

export interface DetectedPrompt {
  kind: "trust" | "tool" | "plan" | "select";
  /** The question as SCRAPED from the screen. The fingerprint is built from this
   *  — see `ask` for the one worth reading. */
  question: string;
  options: PromptOption[];
  /**
   * Checkbox box (AskUserQuestion multi-select): a number key TOGGLES the row
   * instead of answering, so the phone must offer a separate submit rather than
   * sending "<n>\r" the way a single-choice box wants.
   */
  multi?: boolean;
  /**
   * This box has NO NUMBERS: answering it means moving the selection onto the
   * option and pressing Return, not typing a digit.
   *
   * opencode's permission dialog draws its options on one row, unnumbered, with
   * the armed one marked by a background colour; a digit typed at it is a stray
   * character in the composer, and a bare Return presses whatever happened to be
   * armed. So the client must not send `"<n>\r"` — it sends `promptChoice: n`
   * and the host walks the selection there against the rendered screen, refusing
   * rather than pressing Return if it cannot confirm it arrived
   * (`sessions.choosePromptBox()`).
   *
   * It is a fact about the BOX and not about the backend on purpose: the client
   * should never have to know which binary drew a dialog in order to answer it,
   * and a backend that gained a numbered box tomorrow would publish one without
   * this flag on the same socket.
   *
   * Inside `promptFingerprint` — it changes what an answer MEANS, which is the
   * rule that field list is built on.
   */
  nav?: boolean;
  /**
   * The question as the CLI itself posed it, from the pending `AskUserQuestion`
   * tool call in the conversation log. Present only for that kind of box.
   *
   * The scraped `question` is whatever sat above option 1 on a 40-row phone
   * screen — which for a box taller than the screen is nothing at all, i.e. the
   * placeholder. Outside the fingerprint for the same reason as `desc`.
   */
  ask?: string;
  /**
   * The run of options on screen does not start at 1: the box is taller than the
   * terminal and its top has scrolled off. The options published are the ones
   * that are legible; their indices are still what a keystroke means.
   */
  truncated?: boolean;
  /**
   * The word the TUI drew on a checkbox box's COMMIT row — read off the screen,
   * never assumed.
   *
   * Measured on claude 2.1.267: an `AskUserQuestion` carrying several questions
   * draws "Next" there on every question but the last, and Return on "Next"
   * moves to the following question rather than answering. A button reading
   * "Submit" over that row is a claim about what a tap does, so the phone says
   * whichever word is on screen.
   *
   * Absent means nobody could read the row (its cursor or the row itself had
   * scrolled off) and the phone falls back to "Submit" — what it always said.
   * Outside `promptFingerprint` for `desc`'s reason: the two questions of one
   * ask already differ in their question text and their options, so nothing an
   * answer MEANS turns on this alone.
   */
  submitLabel?: "Submit" | "Next";
  /**
   * WHICH box this is, said by the CLI rather than derived from the screen —
   * the pending `AskUserQuestion` call's `tool_use` id plus which of its
   * questions this is (host `askbox.ts`). Present only for that kind of box.
   *
   * It exists because every scrapeable part of a box moves. A box taller than
   * the terminal scrolls its own question row away, and what the detector then
   * joins above option 1 is whatever happens to be there — measured: one live
   * box published its question three different ways inside four seconds, and
   * each spelling was a new `promptFingerprint`, i.e. a card re-opened after it
   * was collapsed, a queued answer gone stale, and a push. This is the one
   * handle a repaint cannot change, so it is what "is this still the same
   * question?" is asked of (`prompt.ts`'s `sameBox`).
   *
   * Outside `promptFingerprint`, for `desc`'s reason: it is identity FOR THE
   * HOST's benefit, arrives with the enrichment, and putting it in would
   * re-derive a different id on every box a log read could not reach.
   */
  askId?: string;
  /**
   * The plan a plan-approval box asks you to approve — the plan FILE's markdown
   * (host `planbox.ts`), because the `ExitPlanMode` call is not in the log until
   * the box is answered and the terminal shows it only as rows scrolled far above
   * the box. Without it the card is "ready to execute — proceed?" with the thing
   * being approved nowhere on the phone.
   *
   * `path` is where the CLI keeps it; `cut` says `text` stopped at the host's cap.
   * Outside `promptFingerprint` for `desc`'s reason: it changes nothing about what
   * a keystroke means, and a plan edited mid-box must not stale a queued answer.
   */
  plan?: { text: string; path: string; cut?: boolean };
}
