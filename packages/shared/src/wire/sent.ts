/**
 * The sent-command audit log: every line waterplane typed into a session, and by
 * whom. (Split out of the retired `wire/oracle.ts`.)
 */
import type { SendView } from "./session.js";

/**
 * One recorded COMMAND SENT INTO A SESSION — the audit trail behind "what did
 * this thing type into my agent, and when?".
 *
 * Everything waterplane drives a session with goes through one of two chokepoints
 * (`deliver.ts`'s verified delivery, or `SessionManager.write()`'s automation
 * write), and until this existed none of it was visible after the fact: a
 * backlog item, a fan-out target, an oracle auto-answer and a usage-limit
 * `continue` all just appeared in the scrollback as if a human had typed them.
 * `HistoryEntry` is the wrong place for it — that is the per-session prompt
 * history the phone re-sends from, keyed to what a person wrote, and it carries
 * no actor, no source and no delivery verdict.
 *
 * Deliberately NOT one entry per PTY write: a delivery types the text and the
 * Return separately and may re-press Return several times, and a per-byte log
 * of the user's own keystrokes would bury exactly the automation this exists to
 * surface. One entry per semantic command, stamped with how it ended.
 */
export interface SentCommand {
  id: string;
  /** Epoch ms — when the send was recorded (delivery end, not start). */
  ts: number;
  sessionId: string;
  /** Title at send time (a session can be renamed or closed afterwards). */
  sessionTitle: string;
  /** Repo/worktree the session runs in, for grouping and the repo label. */
  repoDir: string;
  /** Who asked for it: automation the app decided on, or the person. */
  actor: "auto" | "user";
  /** Which feature sent it. */
  source: SentSource;
  /** What the bytes were. `keys` = a control answer (an option index, Return). */
  kind: "prompt" | "command" | "answer" | "keys";
  /** The text as typed (capped; `truncated` says it was cut). */
  text: string;
  truncated?: boolean;
  /**
   * Delivery outcome. The four `deliver.ts` verdicts, plus `written` for a raw
   * automation write that has no confirmation step at all (an option index into
   * a dialog) — reported honestly rather than dressed up as `ok`.
   */
  result: "ok" | "retry" | "unconfirmed" | "unsubmitted" | "written" | "failed";
  /** One line of extra context (why it fired, what the caller did next). */
  detail?: string;
  /**
   * What the host later PROVED became of this delivery, when `result` was one
   * of the two it could not answer at the time.
   *
   * `result` is what a four-second echo window could see; this is what the CLI's
   * own conversation log and the live screen said minutes later, once there was
   * something to read. The pair is kept deliberately: overwriting `result`
   * would erase the fact that the confirmation machinery could not see it,
   * which is the signal worth watching, and reporting only `result` leaves this
   * log — the one anyone reads as "what happened to my deliveries", and the one
   * the measurement behind this rework was taken from — permanently
   * over-counting failures. "Reported X, settled Y" is the honest row.
   */
  settled?: "landed" | "composer" | "absent" | "unknown";
  /** When that verdict was reached. */
  settledAt?: number;
  /** The sweep's own sentence for it — why it says what it says. */
  settledDetail?: string;
  /** What this delivery was SHAPED like. Diagnostic; absent on an old row. */
  shape?: DeliveryShape;
}

/**
 * The measurable facts about one delivery, kept beside its verdict.
 *
 * `result` says what happened; this says what it happened TO. The two questions
 * this log could not answer were both of that kind — *is a long single-line
 * prompt worse than a short one* (it is: measured here at 46% unconfirmed
 * between 300 and 800 characters against 19% below it) and *does the view the
 * person composed in matter* — and neither is answerable by reading a row that
 * records only text, source and verdict.
 *
 * Every field is OPTIONAL and every one degrades to absent, never to a zero: a
 * grid nobody could read is not an 80x24, and a submit proof that did not run
 * is not a failed one. A row written before this existed simply has none of it,
 * which is why nothing here may be summed without counting the rows that
 * carried it.
 */
export interface DeliveryShape {
  /** Characters written — the FULL text, which `text` above may be capped from. */
  chars: number;
  /** Lines written. A phone prompt is one, and both the composer's paste
   *  collapse and its viewport key on that. */
  lines: number;
  /** The PTY grid at delivery time — the composer is drawn inside it. */
  cols?: number;
  rows?: number;
  /** Which screen the person was composing over (`compose` sends only). */
  view?: SendView;
  /** Which rule recognised the text on screen, or `none` when nothing did. */
  echo?: "exact" | "scrolled" | "head" | "paste" | "none";
  /**
   * What proved the Return. `prompt-hook` is the CLI's own `UserPromptSubmit`
   * naming the text it submitted — the only one of these that is evidence
   * about THIS delivery rather than about the session being busy.
   *
   * `screen-turn` is the weakest of them and is reached by one command:
   * `/compact` fires no hook at all, so the only thing that can answer for its
   * Return is the working line appearing on a session that was idle before it
   * (`shared/slash.ts`'s `worksUnannounced`). Kept apart from `turn` on the
   * audit row precisely because it is weaker.
   *
   * `source` is `prompt-hook`'s twin from a backend's side channel
   * (`sources.delivery.landed`): its own record of a user message whose text
   * equals ours, landing after our Return. Same strength, different witness.
   */
  submit?: "prompt-hook" | "source" | "turn" | "screen-turn" | "screen-moved" | "log" | "none";
}

/** Feature that sent a command. `compose` is the person typing in the app. */
export type SentSource =
  | "compose"
  | "backlog"
  | "fanout"
  | "fanout-followup"
  | "create"
  /** A plugin answered a choice box through the core's gate (`api.answer`). */
  | "plugin"
  /** A person's answer to a question the CLI posed on its own channel, which the CLI asked the
   *  host to TYPE into its own form (`SourceTyped`, `sourceanswer.ts`) — the one place words
   *  reach a session outside `deliver.ts`, so every one is on this log. */
  | "phone"
  /** Legacy: the in-core Gemini oracle, before it became a plugin. Kept so old
   *  rows on disk still type-check and render. */
  | "oracle"
  | "limit";

