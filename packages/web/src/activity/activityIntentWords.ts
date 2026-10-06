import {
  type FanoutRun,
  type Intent,
  type IntentKind,
  intentKind,
  intentReasonText,
  isSpentOnce,
  typedName,
} from "@waterplane/shared";
import {
  recordedFailure,
} from "./activityPieces.ts";
import type { ActivityKind, ActivitySource } from "./activityTypes.ts";

// ── Intent rows: everything the DESKTOP is holding ──────────────────────────

/**
 * **One intent, one row — read, not reconstructed.**
 *
 * This function replaces five: `launchRow`, `backlogRow`, `scheduleRow`,
 * `fanoutRow` and `buildRow`. They were not five different jobs. They were five
 * copies of one job, and the reason they existed is worth writing down, because
 * the shape recurs:
 *
 * The host folded five managers into ONE durable store (`intents/`). Every
 * intent in it carries the decided answer — `state`, `blockReason`, and
 * `blockDetail`, the finished sentence written by the very ladder that made the
 * decision. But the host also kept speaking the five OLD vocabularies on the
 * wire, and each of those DTOs is a projection that drops all three fields.
 * So the phone received five lossy shadows of a fact it could have had whole,
 * and each arm here *guessed the lifecycle back*: `l.state === "waiting" ?
 * "blocked"`, `waiting ? "blocked" : "queued"`, `s.running ? "running" : …`.
 * Five guesses, five vocabularies, five chances to disagree with the host about
 * what is actually happening — and the file said so itself, in `backlogRow`:
 * *"which of the ten block reasons it corresponds to is the host's to publish,
 * and until it does, `null` is the honest answer rather than a guess this list
 * would then sort on."*
 *
 * It publishes them. It always did. Nobody read them.
 *
 * So: `state` is taken, `blockReason` is taken, `verdict` is `blockDetail`.
 * Nothing on this path infers a lifecycle any more, which is why the arm is
 * shorter than any one of the five it replaces and strictly more correct than
 * all five together — a row can no longer say "waiting" while the desktop
 * believes it is running.
 *
 * What stays here is the only thing that is genuinely the phone's: **what a
 * person may do about the row**, and whether the link is up to do it with.
 */

/** The five old vocabularies survive as a LABEL, because the sheet groups by
 *  them and a person thinks in them ("my schedules", "that sweep"). They are no
 *  longer five code paths. */
/* `capture` is filed under `build` on BOTH axes, and that is a statement about
   what it is rather than a shortcut. A capture is a shell run in a repo with no
   session and no tokens, posted the same way, cancelled the same way, and
   finishing with files under `.claude/outbox/` that the same `download` action
   fetches — `builds.ts`'s class of work with a picture at the end. Giving it a
   label of its own would put a seventh word in front of a person for a row that
   behaves identically to the sixth, and would need a new `ActivityKind` member,
   which is an icon `ActivitySheet`'s `KIND_ICON` does not have. What separates a
   capture row from a build row is its TITLE (the target's name) and its verdict
   sentence, which is where the difference is actually legible. */
export const KIND_SOURCE: Record<IntentKind, ActivitySource> = {
  launch: "launch", schedule: "schedule", fanout: "fanout",
  build: "build", assess: "assess", capture: "build", work: "backlog", other: "backlog",
};

export const KIND_ACTIVITY: Record<IntentKind, ActivityKind> = {
  launch: "prompt", schedule: "prompt", fanout: "sweep",
  build: "build", assess: "action", capture: "build", work: "prompt", other: "prompt",
};

/** The prose a person actually wrote, whole. `null` when the row never had any
 *  (a build is a shell command; an assessment is a verb). */
export function intentProse(i: Intent): string | null {
  if (i.payload.kind === "prompt") return i.payload.steps.join("\n\n") || null;
  return null;
}

/**
 * A one-off whose instant has passed, as opposed to one somebody switched off.
 *
 * On the wire these were the same row — `intentToSchedule` derives `enabled`
 * from `nextAt !== null` because an intent has no second flag — so the old
 * `scheduleRow` could not tell them apart and read EVERY spent one-off as
 * "switched off, turn it back on": a sentence pointing at a switch that
 * recomputes the same null and moves nothing. Off the intent the question is
 * simply answerable, which is the whole argument for reading the store.
 */
export function spentOnce(i: Intent, now: number): boolean {
  if (i.trigger.kind !== "at") return false;
  // `isSpentOnce` is the edge, and it is SHARED: the schedule sheet cuts its
  // list with it and the launcher's chip counts with it, so a row this screen
  // calls spent is exactly a row that is no longer in Schedules. This file had
  // its own reading (the rule's instant alone, ignoring `nextAt`), which said
  // spent about a one-off the host still had armed inside its grace window —
  // the one case where it is about to run.
  return isSpentOnce({ rule: i.trigger.rule, nextAt: i.nextAt, lastOccurrence: i.lastOccurrence }, now);
}

/** The sentence, when the host has not written one. It only ever covers states
 *  that are NOT `blocked` — `blockDetail` is present exactly when it matters,
 *  and the fallbacks below are for rows nothing is standing in the way of. */
export function intentVerdictText(i: Intent, kind: IntentKind, now: number, run: FanoutRun | null): string {
  if (i.blockDetail) return i.blockDetail;
  if (i.blockReason) return intentReasonText(i.blockReason);
  if (kind === "fanout" && run) {
    const done = run.targets.filter((t) => t.status === "done").length;
    const failed = run.targets.filter((t) => t.status === "failed").length;
    const total = run.targets.length;
    if (!run.finishedAt) return `${done} of ${total} repos done${failed ? `, ${failed} failed` : ""} — still going`;
    return failed
      ? `${failed} of ${total} repos failed${done ? `, ${done} finished` : ""}`
      : `all ${total} repos finished`;
  }
  switch (i.state) {
    // A capture is a shell run like a build — there is no session to be running
    // "in", and saying there is sends a reader looking for one.
    case "running": return kind === "build" ? "running the command now"
      : kind === "capture" ? "taking the picture now"
      : "running in the session now";
    case "starting": return "starting it now";
    case "canceled": return "stopped";
    // `deliveryError`'s sentence, kept whole and stopped from being an errand
    // once the session it names has long since gone.
    case "failed": return recordedFailure(i.result?.detail, i.settledAt ?? i.createdAt, now, "it ran and did not finish");
    case "done": {
      if (kind === "build") {
        const arts = i.result?.artifacts ?? [];
        // "here is the APK" and "this run made it" are different claims, and
        // only one of them is true for an incremental build that wrote nothing.
        if (arts.length && arts.every((a) => a.stale)) return "finished — nothing was rebuilt, so these are the newest matching files, not this run's output";
        if (arts.length) return `finished — ${arts.length} ${arts.length === 1 ? "file" : "files"} written`;
        return "finished — it wrote no build output";
      }
      if (kind === "schedule" && spentOnce(i, now)) {
        return i.result?.detail ?? "that instant has passed and this was a one-off — post it again if you still want it";
      }
      return i.result?.detail ?? "finished";
    }
    default:
      // `blocked` with neither a reason nor a sentence should be impossible —
      // `blockReason` is documented as present iff the state is `blocked`, and
      // both branches above catch it. If the host ever ships one anyway, say
      // that rather than "next in line", which is the queued row's sentence and
      // would describe a stuck row as a healthy one.
      if (i.state === "blocked") return "the desktop is holding this one and did not say why";
      return kind === "schedule" ? "armed — it will fire on its own" : "next in line for this repo";
  }
}

/**
 * What an intent row is CALLED, and the answer differs by kind — which is what
 * the five builders each encoded separately and is worth keeping.
 *
 * A work item, a parked create and a sweep are titled by **what the person
 * wrote**: the prose is the thing, and a label is a convenience beside it
 * (`backlogRow` titled on `it.text`). A schedule and a build are titled by
 * their **name**: "weekly sweep" and "Release APK" are the identity, and the
 * command or the swept prompt underneath is the detail (`scheduleRow` used
 * `s.name || text`, `buildRow` `r.name || r.cmd`). Getting this backwards
 * renames every work item to whatever short label happened to be attached —
 * `file · 1000074690-mtmw…jpg` in place of the sentence somebody typed.
 *
 * A CAPTURE is named for the same reason a build is: "droplet · home" is the
 * identity of the button somebody tapped, and it is the only string that tells
 * two capture rows in one repo apart. There is no prose anywhere on the row to
 * fall back to — a capture is a target id, not words — so the name is not a
 * convenience here, it is the whole title. `name` is snapshotted on the payload
 * at fire time (the config is edited between runs); when an older host wrote
 * the row without one the id is shown, never a re-derived guess.
 *
 * **A SCHEDULE's `title` is only a name when somebody typed one.** The host
 * fills it in otherwise, with `action.text.split("\n")[0].slice(0, 120)`
 * (`scheduleToIntent`) — so "titled by its name" quietly meant "titled by a
 * 120-character fragment of the prose printed underneath it", which is what
 * this row was: the same string twice, the top copy cut mid-word. `typedName`
 * is the one test for that (the backlog's `realLabel` and the schedule sheet's
 * card ask it too), and when it answers null the prose is the title, which is
 * what the row had all along. `label` still wins where it exists — that one is
 * never derived. Build, assess and capture keep their chains: their names are
 * snapshots of a configured thing, never a slice of anything.
 *
 * ── …and a title a MACHINE wrote goes IN FRONT of the prose ────────────────
 *
 * `Intent.headline` is the other half of `naming.ts`'s pair — the backlog's
 * derived title, on the wire — and it is the one field on a work row that is
 * only ever a TITLE. That is what earns it the front of the queue here: the
 * row's `title` is a HEAD (`ActivityRow.fullText` still carries the words in
 * full, un-clipped, underneath it), so a five-word title over the sentence is
 * strictly more use than the first eighty characters of the sentence twice.
 *
 * **It goes in front of the prose and the prose stays in front of `label`**,
 * which is not `itemHeadline`'s order and is deliberately not. On a BacklogItem
 * `label` is the person's field; on an `Intent` it is also what the send queue
 * MINTS for a row that carries an upload — `file · 1000074690-…jpg`, a string
 * nobody typed and nothing is about — which is the failure the paragraph above
 * documents and `activityRows.test.mjs` pins by name. So this side cannot put
 * `label` first, and the two screens agree where it matters: a machine's title
 * never displaces a person's typed one, because the only way `label` loses here
 * is to prose the same person wrote.
 *
 * **Exported, and un-clipped.** The chain picker in `SendSheet` has to name the
 * row it is about to wait for, and the sentence that row then wears carries the
 * name it was given at that moment (`IntentTrigger.after.title`) — which is a
 * promise about the Activity sheet's vocabulary, not about the picker's. A
 * second copy of this rule living in the sheet would drift, and the first thing
 * that would drift is exactly the case above: a schedule titled by a slice of
 * its own prompt. Clipping stays the caller's (`clip`, `TITLE_MAX`), because a
 * snapshot is stored and a stored ellipsis can never be undone.
 */
export function intentTitle(i: Intent): string {
  const kind = intentKind(i);
  const prose = intentProse(i);
  const build = i.payload.kind === "build" ? i.payload : null;
  const capture = i.payload.kind === "capture" ? i.payload : null;
  const named = kind === "schedule" || kind === "build" || kind === "assess" || kind === "capture";
  return (kind === "schedule"
    ? (i.label || typedName(i.title, prose ?? "") || prose || i.id)
    : named
      ? (i.label || i.title || build?.name || capture?.name || build?.cmd || prose || i.id)
      : (i.headline || prose || i.label || i.title || i.id)).trim();
}
