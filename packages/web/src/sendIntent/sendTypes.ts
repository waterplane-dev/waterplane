/** The four answers of one send, and the seed a sheet opens on. Split from `sendIntent.ts` (docs/notes/send-architecture.md); pure, no React. */
import { type SessionBudget, type ScheduleRule } from "@waterplane/shared";

// ── The intent ───────────────────────────────────────────────────────

export type SendTarget =
  /** A session that exists right now. Its id is per-boot; `cwd` is not. */
  | { kind: "session"; sessionId: string; cwd: string }
  /**
   * A repo, in a session opened FOR this prompt.
   *
   * There used to be two readings of "a repo" here — `fresh` (open a session
   * and run it) and not-`fresh` (add it to the repo's work items, where one
   * shared per-repo conversation ran every item ever queued). They were offered
   * as two segments called *new session* and *work item*, and nobody could say
   * what the second one meant without knowing about a session title the UI
   * never showed. It is retired: `shared/intent.ts`'s `cleanTarget` normalises
   * every repo target to a fresh one, so both segments now DO the same thing
   * and only one of them is drawn.
   *
   * `resume` is the one thing left that was genuinely different about
   * continuing: `claude --continue` in that repo, picking up whatever the last
   * conversation there knew. A choice a person makes on the send, never a
   * side-effect of which segment they tapped.
   */
  | { kind: "repo"; cwd: string; resume?: boolean;
      /** The item's own *close its session when done* (`Intent.closeWhenDone`)
       *  — only where a backlog item or schedule opens the session (not a
       *  `now`, which the person opened). ABSENT inherits the global setting
       *  and sends nothing; `false` is a real "keep this one open". */
      closeWhenDone?: boolean;
      /** The budget the session this send opens is BORN with (`Intent.budget`) —
       *  not a `LaunchOpts` field. Absent is none. A send aimed at a session that
       *  already exists has no field for this: its budget is set on the session. */
      budget?: SessionBudget }
  /** A sweep — one prompt, several repos. `budget` is each session's own. */
  | { kind: "repos"; dirs: string[]; budget?: SessionBudget }
  /** A build command: a shell, no agent, no session. */
  | { kind: "shell"; cwd: string; buildId: string };

export type SendWhen =
  | { kind: "now" }
  /**
   * When the target can actually take it — turn ended, no question open, no
   * usage-limit block. Not a clock.
   *
   * **Held by the DESKTOP, in every shape this sheet can produce.** A live
   * session gets a pinned work item aimed at it; a repo gets one that opens its
   * own session when a slot is free and nothing else is running there. The
   * phone-held park (`holdUntilIdle`) survives only where the host cannot hold
   * it at all — prompts chained behind a session that does not exist yet — and
   * is not reachable from this sheet. One holder is the point: a phone with a
   * locked screen held prompts that never went in.
   */
  | { kind: "idle" }
  /** A wall-clock rule: once, or every week. `name` is what the schedule list
   *  will call it; a blank one is derived from the prompt. */
  | {
      kind: "at";
      rule: ScheduleRule;
      graceMin: number;
      name?: string;
      /**
       * An ADDITION to `rule`, not an alternative anchor — ticked, this schedule
       * still fires when `rule` says, but holds the actual run until nothing
       * else is happening: this repo's own session free, and nothing else
       * auto-starting anywhere on the host. See `ScheduleEntry.waitUntilFree`.
       *
       * Why it is not folded into the *now* / *when it's free* row above: that
       * row picks between two INSTRUCTIONS about a live target and does not
       * apply once a wall-clock rule is in the picture at all — a schedule has
       * no live target yet to be free. This is a property of the SCHEDULE
       * itself, tickable regardless of which anchor or "how often" is chosen,
       * which is exactly why it needed to stop being that row's third option.
       */
      waitUntilFree?: boolean;
    }
  /**
   * After another piece of work has finished — a chain across rows, and across
   * repos.
   *
   * The third answer to "not yet", and the one the other two could not give.
   * `idle` answers to a live target, `at` answers to a clock; neither can say
   * "when the migration finishes, review it", which is the commonest real
   * dependency there is. People were expressing it by guessing a wall clock far
   * enough out, and a guess is either wasteful or silently wrong in the
   * direction of reviewing a half-finished migration.
   *
   * It is deliberately NOT a `ScheduleRule` and produces no schedule row: there
   * is no recurrence and no clock to arm, so `isBacklogRow` files a chained
   * prompt as WORK. What the sheet composes here becomes an `IntentTrigger`
   * `{kind:"after"}` on an `intent.post`, which is the one shape the ladder's
   * rung 3 reads.
   *
   * `id` is the predecessor's intent id — stable for that row's whole life.
   * `title` is a SNAPSHOT of what that row was called at the moment the chain
   * was made, carried so the waiting row can still name what it is waiting for
   * after the predecessor has settled, been dismissed and been compacted out of
   * the live file. It is optional and every sentence here degrades to naming no
   * title rather than to naming a wrong one.
   *
   * `onlyIfOk` is the difference between "afterwards" and "if it worked":
   * absent, a failed predecessor still releases the chain, because "run the
   * tests, then tell me what happened" wants to run either way.
   */
  | { kind: "after"; id: string; title?: string; onlyIfOk?: boolean };

export interface SendIntent {
  /** The chain. `[0]` is the first turn; the rest are delivered one at a time. */
  prompts: string[];
  target: SendTarget;
  when: SendWhen;
  /**
   * One at a time, rather than all at once. Only two shapes can honour it with
   * the send paths that exist (see `sequentialMeans`), and offering it anywhere
   * else would be a switch that quietly does nothing.
   */
  sequential: boolean;
}

/**
 * A send being composed, minus the words.
 *
 * The prompt survives the trip through the annotator because it is a DRAFT on
 * disk; this is the same promise for the other three questions the sheet asks.
 * It is not folded into `SendSeed`: a seed is where the send CAME from and is
 * written once by whoever opened the sheet, while this is what the person has
 * since decided and is rewritten on every tap.
 */
export interface SendResume {
  target: SendTarget;
  when: SendWhen;
  sequential: boolean;
  /**
   * **The `at` rule the sheet is HOLDING but not using** (`atMemo`).
   *
   * Leaving the clock for `now`, `when it's free` or a chain does not delete the
   * rule — the row says *"The schedule you set is kept"* — and that promise has
   * to survive the one trip this sheet explicitly survives: out to the annotator
   * and back. It did not. `onDecide` reported the three LIVE answers, so
   * configure a weekly rule, tap `now` to see what it says, attach a picture and
   * come back, and the sheet remounted with `when: now`, no memo, no hint and no
   * rule — seven taps gone, after a sentence saying they were kept. Which is the
   * "never overwrite words nobody typed" rule applied to a decision instead of
   * to prose; a schedule is something somebody made.
   */
  parkedAt?: SendWhen;
}

/**
 * **What the WHEN row comes back as after a round trip — both halves of it.**
 *
 * One function rather than two reads at the mount, because the bug was exactly
 * that the two were read apart: the live answer was resumed and the parked one
 * was not, so the sheet came back saying *now* with the hint gone and the rule
 * with it, one sentence after promising it was kept. A remount that restores
 * three quarters of a decision is its own small delete.
 *
 * `seedWhen` is the caller's opening answer, used only on the FIRST mount — a
 * resume always wins, including when it resumed a `now` the person chose.
 */
export function resumeWhen(
  resume: SendResume | null | undefined,
  seedWhen: SendWhen | undefined,
): { when: SendWhen; parkedAt: SendWhen | null } {
  return {
    when: resume?.when ?? seedWhen ?? { kind: "now" },
    parkedAt: resume?.parkedAt ?? null,
  };
}

/**
 * Where a send came from, and what a successful post retires.
 *
 * The retire contract is the reason "send again" stops asking which repo: a
 * queue row, a pad note and a give-up row all already KNOW the words' `cwd`,
 * and every picker in the app was still asking a message that had answered.
 */
export interface SendSeed {
  prompts?: string[];
  target?: SendTarget;
  when?: SendWhen;
  sequential?: boolean;
  /** The repo these words came from — home-first ordering in every picker. */
  cwdHint?: string | null;
  /** Which repo the `.claude/inbox/…` paths in the text belong to. */
  repoId?: string | null;
  /** A queue row's ackId, dropped once the new send is queued. */
  ackId?: string;
  /** A pad note's id — sending it takes it off the pad. */
  padId?: string;
  /** An existing schedule being edited: `schedule.save` upserts on this id. */
  scheduleId?: string;
  /** One line saying where this came from ("From the pad", "not delivered"). */
  origin?: string;
  /** Check the files the text names, and offer to repair each one. */
  repair?: boolean;
  /** Where the half-written send is persisted, per keystroke. */
  draftKey?: string;
  /** Run once the post is accepted — the compose box clearing itself, say.
   *  Never on a refusal: the words have to stay where they are. */
  onPosted?: () => void;
  /**
   * Land on the session this went to, once it has gone.
   *
   * Set by the three entry points that are a RE-send of a message that never
   * arrived (the queue row, the Activity row, the not-delivered bar). All three
   * are reached by someone who has just been told their words are unsent, and
   * the answer to "did it go this time?" is on the session's own screen — which
   * used to be two screens away behind a toast, on a phone, from inside an
   * overlay they now had to dismiss themselves. Only honoured when the send
   * actually ended up aimed at a session: a rewrite may be re-aimed at a repo or
   * a sweep in the same sheet, and there is no one screen for those.
   */
  openAfter?: boolean;
  /**
   * **Re-time mode**: a new WHEN for rows that already exist, many at once.
   *
   * The sheet shows the When editor and nothing else — no words (each row
   * keeps its own), no *To* (each keeps its own target), no attachments — and
   * its button hands the WHEN back to `onSend` for the caller to patch onto
   * every id. The full editor rather than a clock picker because a re-time is
   * the same decision as a send's WHEN: a usage window, a condition, a
   * repeat, late runs, *wait until it's free*.
   */
  retime?: { ids: string[] };
}

/**
 * Where the Send sheet's half-written message lives, per keystroke.
 *
 * One key, not one per entry point: only one send is being composed at a time,
 * and the round trip through the ANNOTATOR (which unmounts the sheet) has to
 * find the same buffer coming back. `openSend` writes the seed into it, so a
 * seeded open and a resumed one are the same code path; the annotator and the
 * gallery's *insert path* append to it (`features/images`).
 */
export const SEND_DRAFT = "send.compose";

/**
 * The seed the sheet actually opens on, once the draft slot has answered.
 *
 * A `refused` rescue (the pad is full) writes NOTHING, so the slot still holds
 * the OLD draft — and `SendSheet` seeds its prompts from the slot first. The
 * sheet is then composing words that are not this seed's, while the seed's
 * `padId`/`ackId` still name the note and the queue row it came FROM: one tap
 * on Send posts the stale draft and `retireSendSource` tombstones a note whose
 * words never went anywhere. Reachable exactly when the pad is full, which is
 * precisely when somebody opens `send…` on a note to make room. So a refusal
 * drops the SOURCE and keeps the words; the toast already says why the pad
 * would not take the rescue.
 */
export function seedAfterRescue(seed: SendSeed, rescue: "seeded" | "kept" | "refused"): SendSeed {
  if (rescue !== "refused") return seed;
  if (seed.padId === undefined && seed.ackId === undefined) return seed;
  return { ...seed, padId: undefined, ackId: undefined };
}

/** Everything the words need to become a sentence. */
export interface SendNames {
  repoName: (cwd: string) => string;
  sessionTitle: (sessionId: string) => string;
  buildName: (cwd: string, buildId: string) => string;
}

