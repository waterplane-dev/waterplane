/**
 * The prose question and the CLI's own proposal: whether a finished turn ended
 * on a question to the person (`checkAsking`, `setAsking`, `ackAsking`), and
 * the next prompt the CLI proposes (`checkCliSuggestion`), plus a plugin's
 * suggestion (`setSuggestion`). Cut out of `turn.ts` by subject; stateless like
 * it — every fact lives on the `Session`.
 */
import type { SessionAsk } from "@waterplane/shared";
import { derive } from "../backends/derive.js";
import { stripAnsi } from "../prompt.js";
import { askLine, looksLikeQuestion, sameAsk } from "../question.js";
import { cliSuggestionOf, composerPlain } from "../clisuggest.js";
import type { Session, SessionCore } from "./core.js";
import { QUESTION_TAIL_BYTES } from "./knobs.js";

/**
 * Did this turn end on a question to the person, asked in prose?
 *
 * Run on the turn-end transition, before the ping. Deliberately NOT a
 * detector of "is the CLI blocked" — it is not; the composer is right there.
 * It is a detector of WORK being blocked, which is the state the phone had no
 * word for: a finished turn whose next step is a decision only the user can
 * make. It used to be computed only when the Gemini oracle was on duty, so
 * without an API key nothing ever asked the tail this question.
 *
 * A parsed `prompt` outranks it (that is the same question with buttons), and
 * a limit-blocked session is not waiting on an answer, it is waiting on a
 * clock.
 */
export function checkAsking(core: SessionCore, s: Session): void {
  // "Did the turn end on a question with no box" is a rule about how THIS CLI
  // signs off a turn. A backend it was not written against records nothing:
  // `SessionInfo.asking` stays absent, and the phone's "asked you" badge can
  // never be raised by a paragraph that merely ends in a question mark.
  if (derive(s.backend).screen("asking") !== "question-ts") { setAsking(core, s, null); return; }
  if (s.info.prompt || s.info.limit?.blocked) { setAsking(core, s, null); return; }
  // A turn still IN FLIGHT is not a turn that ended on a question. The
  // silence timer re-enters `markIdle` four seconds after any output, so on a
  // hooked session a long quiet tool run would otherwise read the agent's
  // mid-turn "should I also…?" as a handover and badge a working session
  // "asked you" until someone typed. Only a turn that is over may raise it;
  // by this point `markIdle`/the Stop hook have already cleared the flag for
  // the sessions that legitimately finished.
  if (s.turnActive) return;
  // The rendered grid, not the byte tail: the CLI lays words out with cursor
  // moves, and the stripped bytes read "TheUIisstillwronghere" on the card.
  const tail = s.screenLog?.gridText() || stripAnsi(s.scrollback.slice(-QUESTION_TAIL_BYTES));
  if (!looksLikeQuestion(tail)) { setAsking(core, s, null); return; }
  const text = askLine(tail);
  if (!text) { setAsking(core, s, null); return; }
  // Already dealt with — outside this session, which is the only place it
  // COULD have been dealt with without a turn starting. The tail still ends
  // on the question and always will, so without this the badge re-raises on
  // the next repaint and the acknowledgement lasts about a second.
  const d = s.askDismissed;
  if (d && ((s.hooksActive && d.stop === s.stopCount) || sameAsk(text, d.text))) { setAsking(core, s, null); return; }
  // Keep the original `at`: idle re-enters here on every repaint, and a
  // question whose clock restarted twice a second would read "asked 0s ago"
  // for as long as it went unanswered.
  setAsking(core, s, { text, at: s.info.asking?.at ?? Date.now() });
}

/**
 * Is the composer showing the CLI's own proposal for the next prompt?
 * (`clisuggest.ts` holds the rule and the measurement.)
 *
 * Re-entered on every quiet repaint, like `checkAsking` — the proposal is a
 * model call of the CLI's own and lands a moment AFTER the Stop, so one read on
 * the transition would miss it. The plain grid is the cheap gate; the render
 * with attributes is paid once per distinct composer text.
 */
export function checkCliSuggestion(core: SessionCore, s: Session): void {
  // Measured on claude's TUI only (`clisuggest.ts`); another TUI's dim hint is a placeholder. The
  // claude TUI is the one whose dialogs `prompt.ts` reads — so every backend that runs it.
  if (derive(s.backend).screen("dialogs") !== "claude-numbered" || s.turnActive || s.info.prompt || s.info.limit?.blocked) {
    s.hintRead = null;
    setCliSuggestion(core, s, null);
    return;
  }
  const grid = s.screenLog?.gridText();
  if (!grid) return;
  const rows = grid.split("\n");
  const plain = composerPlain(rows);
  if (!plain) { s.hintRead = null; setCliSuggestion(core, s, null); return; }
  if (plain === s.hintRead) return;
  s.hintRead = plain;
  void core.screenCells(s.info.id, rows.length).then((cells) => {
    if (s.hintRead !== plain || s.turnActive) return; // the screen moved on while this rendered
    setCliSuggestion(core, s, cliSuggestionOf(rows, cells.map((r) => r.undimmed)));
  }).catch(() => { /* no reading — leave what is published */ });
}

export function setCliSuggestion(core: SessionCore, s: Session, text: string | null): void {
  if ((s.info.cliSuggestion ?? null) === text) return;
  s.info.cliSuggestion = text;
  core.emit("updated", s.info);
}

/** Publish/retire the prose-question fact, on a CHANGE of wording only. */
export function setAsking(core: SessionCore, s: Session, ask: SessionAsk | null): void {
  const had = s.info.asking?.text ?? null;
  if ((ask?.text ?? null) === had) return;
  s.info.asking = ask;
  core.emit("updated", s.info);
}

/**
 * "I have dealt with that" — retire the prose-question badge without typing.
 *
 * The only two things that retire `asking` on their own are a turn starting
 * and a keystroke, both of which mean the question was answered HERE. A
 * question answered anywhere else — the change committed at the desk, the
 * decision taken and no longer worth a reply — has neither, so the badge, the
 * waiting count and the push stood over a decision already made.
 *
 * `text` is checked for the reason `expectPrompt` exists: the tap happened
 * against a badge that may since have been replaced by a different question,
 * and silencing THAT one is the failure this guard is here to prevent. A
 * client that cannot say (absent) acknowledges whatever is standing.
 *
 * Types nothing, runs nothing, and is not remembered past the next turn.
 */
export function ackAsking(core: SessionCore, id: string, text?: string): void {
  const s = core.sessions.get(id);
  if (!s?.info.asking) return;
  const cur = s.info.asking.text;
  if (text != null && !sameAsk(text, cur)) return;
  s.askDismissed = { text: cur, stop: s.stopCount };
  s.info.asking = null;
  persistAsk(core, s);
  core.emit("updated", s.info);
}

/** Rewrite the `live/` record so "handled" survives a restart — `persistLive`
 *  takes `askDismissed` off the live session. */
function persistAsk(core: SessionCore, s: Session): void {
  const m = core.loadLive(s.info.id);
  if (m) core.persistLive(m);
}

/**
 * Attach a plugin's suggestion to a session. A numbered-CHOICE suggestion is
 * tied to a live prompt, so it's dropped if the prompt already changed (stale)
 * — we never show a choice for a gone prompt. A free-text REPLY suggestion
 * (choice == null) has no prompt to bind to, so it's always allowed; this is
 * what surfaces the turn-end reply bar.
 */
export function setSuggestion(core: SessionCore, id: string, s: import("@waterplane/shared").AnswerSuggestion | null): void {
  const sess = core.sessions.get(id);
  if (!sess) return;
  if (s && s.choice != null && !sess.info.prompt) return; // stale numbered choice
  sess.info.suggestion = s;
  core.emit("updated", sess.info);
}
