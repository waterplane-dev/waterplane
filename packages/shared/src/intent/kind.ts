/**
 * What KIND of thing an intent is: the origin strings, the row classifiers
 * (`isScheduleRow`, `isTimedWorkRow`, …), the clock keys and `intentKind` —
 * one classification for both ends.
 *
 * A slice of `../intent.ts`, which is the one door into the intent model —
 * import from there, never from here. Layout and import order:
 * docs/notes/shared-architecture.md.
 */

import type { ScheduleRule } from "../schedule.js";
import { ruleRecurs } from "../schedule.js";
import type { Intent } from "./row.js";

// ── What KIND of thing an intent is ─────────────────────────────────────────

/**
 * **The one classification of an intent, shared by both ends.**
 *
 * `intents/` folded five managers into one store, and each of the five old
 * vocabularies became a FILTER over the same rows. Those filters lived in
 * `host/intents/adapters.ts` — which is correct while the host is the only
 * reader, and stops being correct the moment the phone reads the store too.
 *
 * The failure it prevents is not "two copies drift". It is worse and more
 * specific: `adapters.ts` flattens an `Intent` into a per-vocabulary DTO that
 * has **no `state`, no `blockReason` and no `blockDetail`**, and the phone then
 * *reconstructed* a lifecycle from what survived. Five reconstructions, each
 * guessing at facts the host had already decided and thrown away in transit —
 * `activityRows.ts` said so in its own comments ("which of the ten block
 * reasons it corresponds to is the host's to publish, and until it does, `null`
 * is the honest answer rather than a guess this list would then sort on").
 *
 * So the classifiers move here, the phone reads `Intent` directly, and the
 * guessing is deleted rather than kept in step.
 *
 * The origin strings are part of the classification (a fan-out row is one only
 * by provenance), so they live here too rather than being re-typed on the far
 * side of the wire.
 */
export const ORIGIN_FANOUT_RUN = "fanout:run";
export const ORIGIN_FANOUT_TARGET = "fanout";
export const ORIGIN_FANOUT_FOLLOWUP = "fanout:fu:";

/**
 * **An AGENT posted this row** — a `claude` working in one of this desktop's
 * repos asked for later work through the host's loopback route
 * (`agentintents.ts`), because the person asked it to ("run this 3 h before the
 * weekly reset"). Written by the host on that route and nowhere else: a client
 * cannot claim it, and the route cannot drop it.
 *
 * The row is otherwise an ordinary intent, edited and deleted on the phone like
 * any other. The mark exists so the person can tell a row they did not type from
 * one they did — `AGENT_POSTED_WORDS` is how both of the phone's lists say it.
 */
export const ORIGIN_AGENT = "agent";
/** Did an agent post this? Exact, never a prefix — `origin` is capped at 40. */
export const isAgentPosted = (i: { origin?: string }): boolean => i.origin === ORIGIN_AGENT;
/** A job a PEER desktop posted here: `origin` is `peer:<name>` (the name this
 *  host lists the peer by; `origin` is capped at 40). Written by the host on the
 *  token-gated peer route and nowhere else. */
export const ORIGIN_PEER_PREFIX = "peer:";
export const isPeerPosted = (i: { origin?: string }): boolean =>
  !!i.origin?.startsWith(ORIGIN_PEER_PREFIX) && i.origin.length > ORIGIN_PEER_PREFIX.length;
/** Which peer posted it; undefined for any other origin or an empty name. */
export const peerOfOrigin = (origin: string | undefined): string | undefined => {
  if (!origin?.startsWith(ORIGIN_PEER_PREFIX)) return undefined;
  return origin.slice(ORIGIN_PEER_PREFIX.length) || undefined;
};
/** The one wording of that mark, for the backlog row and the Activity row. */
export const AGENT_POSTED_WORDS = "posted by an agent — edit or delete it like any other";
/** What a `manual` row says it is waiting for — rung 1's detail, and the
 *  backlog row's note (`Intent.manual`). */
export const MANUAL_HOLD_TEXT = "waits for your tap — nothing starts it by itself";

/**
 * **Which standing rule wrote this work item** — the schedule ↔ backlog seam as
 * a FACT on the row, instead of a join a screen has to guess at.
 *
 * The link used to exist only as `ScheduleResult.childId`, which is the LAST
 * item a rule wrote and nothing before it: a nightly rule that had run four
 * times showed *backlog · 1 item*, and three rows in the list said nothing about
 * where they came from. `origin` is durable, is already on the wire
 * (`intentToBacklogItem`), and survives the rule firing again.
 *
 * Absent by design on rows written before this existed — a chip that is not
 * there is the honest answer, and a guess from the label would be wrong on every
 * item somebody typed a similar name for.
 *
 * ONE reader and ONE writer, because `schedule:` already had two RESERVED
 * suffixes (`schedule:work` and `schedule:sweep` mark the rule's OWN row, in
 * `intents/manager.ts`), and a bare `startsWith("schedule:")` on the far side of
 * the wire would read those as an entry id called "work".
 */
export const ORIGIN_SCHEDULE_PREFIX = "schedule:";
const SCHEDULE_ROLE_SUFFIXES = new Set(["work", "sweep"]);

/** What a schedule stamps on the item it creates. */
export const scheduleItemOrigin = (entryId: string): string => `${ORIGIN_SCHEDULE_PREFIX}${entryId}`;

/** …and the only way to read it back: the rule's id, or `undefined` for a row
 *  that did not come from one (including the rule's own row). */
export function scheduleIdFromOrigin(origin?: string): string | undefined {
  if (!origin?.startsWith(ORIGIN_SCHEDULE_PREFIX)) return undefined;
  const id = origin.slice(ORIGIN_SCHEDULE_PREFIX.length);
  return id && !SCHEDULE_ROLE_SUFFIXES.has(id) ? id : undefined;
}

/** A parked `session.create`. The trigger IS the discriminator — a create
 *  waiting on files is the only thing that waits on files. */
export const isLaunchRow = (i: Intent): boolean => i.trigger.kind === "files";

/** One repo of a sweep, or the parent sweep itself. Provenance, not shape:
 *  a fan-out child is otherwise indistinguishable from a work item. */
export const isFanoutRow = (i: Intent): boolean =>
  !!i.groupId && (i.origin === ORIGIN_FANOUT_TARGET
    || i.origin === ORIGIN_FANOUT_RUN
    || (i.origin?.startsWith(ORIGIN_FANOUT_FOLLOWUP) ?? false));

/**
 * **A one-off with a clock, aimed at ONE place.** Waiting work whose WHEN
 * happens to be an instant rather than "as soon as the target is free" — and
 * therefore a BACKLOG row, not a schedule card.
 *
 * It is `after`'s argument one trigger over (see `isBacklogRow`): such a row is
 * spent by its one run, so there is no recurrence, no clock to ARM again,
 * nothing for the schedule sheet to pause or skip. Filing it under Schedules
 * put it on the one screen whose verbs it cannot use and took it off the list
 * of the repo's waiting work — which is what it is. Measured, on this desktop:
 * 9 live `at` rows, every one of them one-off, zero recurring; seven of them
 * `failed`, in no backlog, and invisible to the smart pick, which only ever
 * looks at backlog rows.
 *
 * Two exclusions, both deliberate:
 *  - a rule that RECURS is a standing thing, whatever it is aimed at;
 *  - a one-off SWEEP (`repos`) has no single backlog to live in, so it stays a
 *    card until it is spent.
 *
 * **Derived, never stored.** An edit that flips *once* ↔ *every week* moves the
 * row between the two lists on the next read, with nothing to migrate and no
 * field on disk that could disagree with the trigger beside it.
 */
export const isTimedWorkRow = (i: Intent): boolean =>
  i.trigger.kind === "at" && !ruleRecurs(i.trigger.rule)
  && i.payload.kind === "prompt"
  && (i.target.kind === "repo" || i.target.kind === "session")
  && !isFanoutRow(i);

/** A standing rule on the wall clock — or a one-off SWEEP, which has no single
 *  backlog to live in. Again the trigger discriminates, minus the one-offs
 *  above, which are work. */
export const isScheduleRow = (i: Intent): boolean => i.trigger.kind === "at" && !isTimedWorkRow(i);

/**
 * Origins the host's manager ROUTES on — the two schedule adapters. `origin`
 * is otherwise free-form provenance; see the manager's note on them. Here so
 * the phone can ask the same question the executor dispatch asks.
 */
export const ORIGIN_SCHEDULE_WORK = "schedule:work";
export const ORIGIN_SCHEDULE_SWEEP = "schedule:sweep";

/**
 * Does firing this row ADD a backlog item rather than run anything? A standing
 * rule whose action is "queue a work item" (`manager.execute`'s one exception):
 * its run makes a child that waits its turn in the repo's queue, so a verb that
 * fires it skips nothing and starts no second agent.
 */
export const queuesBacklogItem = (i: Intent): boolean => i.origin === ORIGIN_SCHEDULE_WORK && isScheduleRow(i);

/**
 * Equality key for *these two rows wait on the SAME clock* — the smart pick's
 * merge rule, which may fold two items into one only when it is not thereby
 * deciding a clock.
 *
 * `undefined` for a row with no clock, so an untimed row never accidentally
 * compares equal to a timed one: two `undefined`s are equal as values and the
 * callers must ask `isTimedWorkRow` (or compare on the key AND its presence)
 * rather than on `===` alone.
 */
export const timedWorkKey = (i: Intent): string | undefined =>
  isTimedWorkRow(i) && i.trigger.kind === "at"
    ? clockKey(i.trigger.rule, i.trigger.graceMin, i.holdForHost)
    : undefined;

/**
 * …and the key itself, off the three fields that make a clock rather than off
 * an `Intent`.
 *
 * The phone asks the same question of a `BacklogItem` (which carries the rule,
 * the grace and the hold and no trigger at all) when it groups the rows waiting
 * on one instant and says which of them runs first. Two spellings of *the same
 * clock* would be two answers to "may these be folded into one" and "are these
 * one group" — the failure `timedWorkKey` was written to prevent, one DTO over.
 * So the comparison lives here once and `timedWorkKey` is the `Intent`-shaped
 * door to it.
 */
export const clockKey = (rule: ScheduleRule, graceMin: number, holdForHost?: boolean): string =>
  JSON.stringify([rule, graceMin, holdForHost ? 1 : 0]);

/** A shell command with no agent in it. */
export const isBuildRow = (i: Intent): boolean => i.payload.kind === "build";

/** The plainest intent there is: prose, aimed at a repo or a session, run when
 *  the target is free. Defined by SHAPE and not by an `origin` marker, and
 *  stated last because it is what is left once the four above have taken
 *  theirs. */
export const isBacklogRow = (i: Intent): boolean =>
  i.payload.kind === "prompt"
  // `after` belongs in this list and not in `isScheduleRow`'s: a chained item
  // is a work item whose WHEN happens to be an event rather than "as soon as
  // the target is free". It is not a standing rule — there is no recurrence,
  // no clock to arm, nothing for the schedule sheet to pause — and filing it
  // there would put it on the one screen that cannot say anything true about
  // it, while taking it off the list of the repo's waiting work, which is
  // exactly what it is.
  //
  // **And a NON-RECURRING `at` is the same argument with an instant in place of
  // the event** (`isTimedWorkRow`). Recurrence, not trigger kind, decides which
  // list a row lives in: a standing rule is a thing to arm, pause and skip; a
  // one-off is waiting work that happens to carry a clock. The exception, and
  // the only one, is a one-off SWEEP — `repos` has no single backlog to live
  // in, so `isTimedWorkRow` refuses it and it stays a schedule card.
  && (i.trigger.kind === "now" || i.trigger.kind === "idle" || i.trigger.kind === "budget"
    || i.trigger.kind === "after" || isTimedWorkRow(i))
  && (i.target.kind === "repo" || i.target.kind === "session")
  && !isFanoutRow(i);

/** An assessment run — `assess.ts`'s headless grader. */
export const isAssessRow = (i: Intent): boolean => i.payload.kind === "assess";

/** A verified capture run — `capture.ts`'s picture-with-a-verdict. Like
 *  `isBuildRow`, defined by the PAYLOAD: it is a shell-target run with no agent
 *  in it, and nothing else in the store has this payload kind. */
export const isCaptureRow = (i: Intent): boolean => i.payload.kind === "capture";

/**
 * The vocabularies, as one closed set.
 *
 * `other` is deliberate and is not a bucket for bugs: an intent kind added
 * later must render as *something* on a phone pinned to an older bundle, and a
 * row that silently disappears from the one screen that answers "did my work
 * run?" is the failure that screen exists to prevent. `capture` is the proof
 * that it works — an APK holding a bundle from before this line renders a
 * capture run as `other`, which is a row with a state and a time on it, rather
 * than nothing at all.
 */
export type IntentKind = "launch" | "schedule" | "fanout" | "build" | "assess" | "capture" | "work" | "other";

/** Order matters: the specific tests run before the shape test that would
 *  otherwise also match a fan-out child. The order is UNCHANGED by timed work —
 *  `isScheduleRow` simply no longer claims a one-off aimed at one place, so it
 *  falls through to `work`, which is the kind whose verbs it needs. */
export function intentKind(i: Intent): IntentKind {
  if (isLaunchRow(i)) return "launch";
  if (isScheduleRow(i)) return "schedule";
  if (isFanoutRow(i)) return "fanout";
  if (isBuildRow(i)) return "build";
  if (isAssessRow(i)) return "assess";
  if (isCaptureRow(i)) return "capture";
  if (isBacklogRow(i)) return "work";
  return "other";
}
