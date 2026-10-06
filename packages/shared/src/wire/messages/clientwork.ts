// Client → host: work the host runs — builds, artifacts, captures, assessments, fan-out, pulls, schedules, intents. Member list of `ClientMessage` in `../messages.ts`. 

import type { ArtifactPolicy } from "../../artifacts.js";
import type { AssessChoices } from "../../assess.js";
import type { IntentTarget } from "../../intent.js";
import type { IntentDraft, IntentPatch } from "../intent.js";
import type { SessionBudget } from "../../sessionbudget.js";
import type { SendStamp } from "../../sendstamp.js";
import type { ScheduleEntry } from "../../schedule.js";
import type { CaptureTarget } from "../capture.js";
import type { LaunchOpts } from "../session.js";
import type { AutoPullConfig, BuildConfig } from "../work.js";

export type ClientWorkMsg =
  // ── Build buttons (run a repo build command without a claude session) ──
  /** Fetch a repo's configured builds + its recent runs (host replies build.list + build.output tails). */
  | { t: "build.list"; repoDir: string }
  /** Persist a repo's whole build list (add/edit/delete/reorder). */
  | { t: "build.save"; repoDir: string; builds: BuildConfig[] }
  /** Run one configured build now — spawns a shell, streams output, no tokens spent.
   *  `ackId` (optional): durable-op receipt — see `op.ack`.
   *
   *  `params` (optional) are the values for whatever the entry declares
   *  (`BuildConfig.params`). Absent ⇒ every parameter falls back to its stored
   *  default, and one with no default REFUSES the run in words rather than
   *  running on a blank — which is what an unattended fire and an older client
   *  both hit. */
  | ({ t: "build.run"; repoDir: string; buildId: string; params?: Record<string, string>; ackId?: string } & SendStamp)
  /** Kill a running build. */
  | { t: "build.cancel"; runId: string }
  /**
   * What this repo does with what its builds PRODUCE — read it (`artifacts.get`)
   * and set it (`artifacts.save`).
   *
   * Additive, not durable, not queued offline, `PROTOCOL_VERSION` did not move for it: it is
   * a small idempotent preference that the next tap re-saves, exactly like
   * `pull.save` beside it. Both are answered with `artifacts.config`, which is
   * BROADCAST on a save (the policy belongs to the project, so a second phone
   * must not go on showing the switch the desktop just flipped).
   */
  | { t: "artifacts.get"; repoDir: string }
  | { t: "artifacts.save"; repoDir: string; policy: ArtifactPolicy }
  /**
   * "What can this repo already build?" — read the repo's own manifests and
   * answer `build.candidates`.
   *
   * Additive, `PROTOCOL_VERSION` did not move for it; a host that never heard of it ignores
   * it, and the editor then simply offers nothing (it says so rather than
   * spinning).
   *
   * Not durable and carries no ackId. It reads files and writes nothing, so a
   * frame that arrived twice costs a second directory walk and produces the
   * same list — there is nothing for at-most-once to protect. CONTAINED like
   * its `build.list` sibling, because the directory is the client's word.
   */
  | { t: "build.scan"; repoDir: string }
  /**
   * "What can I pick for this build's parameters?" — run each `optionsCmd` the
   * entry declares and answer `build.options`.
   *
   * Additive, `PROTOCOL_VERSION` did not move for it: a host that never heard of it ignores
   * it, and the form then offers the static options it already has plus a typed
   * field, saying which of those two happened rather than spinning.
   *
   * Not durable and carries no ackId — it runs read-shaped one-liners out of the
   * repo's own build config, so a frame that arrived twice costs a second
   * listing and answers the same. CONTAINED like `build.list`, because the
   * directory is the client's word and this ends in a shell.
   */
  | { t: "build.options"; repoDir: string; buildId: string }
  // ── Verified capture (take a picture of a running screen, and say how much
  //    the picture can be trusted) ──
  //
  // Additive, `PROTOCOL_VERSION` did not move for it — the `intent.*` / `schedule.skipNext`
  // precedent. A host that never heard of these ignores them (an unknown `t` is
  // a no-op by design), and an OLD phone bundle classifies a capture intent as
  // `intentKind` "other", which ActivitySheet already renders. That is the
  // designed degradation in both directions, and it is what lets the APK pin a
  // bundle either side of this change.
  /** Fetch a repo's configured capture targets, its recent runs, and which
   *  backends this desktop can actually drive (host replies `capture.list`).
   *
   *  Contained, not durable: it reads and writes nothing, so a frame that
   *  arrived twice costs a second file read and produces the same list. */
  | { t: "capture.list"; repoDir: string }
  /** Persist a repo's whole target list (add/edit/delete/reorder), `build.save`'s
   *  contract: the client owns the list and saves it whole. CONTAINED, because
   *  the directory is the client's word. */
  | { t: "capture.save"; repoDir: string; targets: CaptureTarget[] }
  /**
   * Take the picture now.
   *
   * Durable and CONTAINED, for the two reasons `build.run` is both: it runs a
   * command in a directory the CLIENT named, and a replay that ran twice would
   * put two runs in a fight over one lease (one simulator, one device, one
   * browser on one port). `ackId` (optional) is the durable-op receipt — see
   * `op.ack`.
   *
   * `watch` keeps capturing until cancelled, emitting a frame only when the
   * screen has changed past the target's `diffPct`.
   */
  | ({ t: "capture.run"; repoDir: string; targetId: string; watch?: boolean; ackId?: string } & SendStamp)
  /**
   * Stop a running capture.
   *
   * Deliberately NOT durable and never queued offline, for `intent.cancel`'s
   * reason: a cancel delivered an hour late calls off work that has since run.
   * That is why it carries no `ackId` — there is no at-most-once story for a
   * message that must never be replayed at all.
   */
  | { t: "capture.cancel"; runId: string }
  // ── Assessment (one repo, everything still open, judged with evidence) ──
  //
  // Additive, `PROTOCOL_VERSION` did not move for it. A host that has never heard of these
  // ignores them (an unknown `t` is a no-op by design), which is what lets the
  // APK pin a bundle either side of this change.
  /**
   * Read this repo and judge what is left in it.
   *
   * Durable and CONTAINED, for the two reasons `build.run` is both: the run
   * spends an agent reading a whole repo, so a retry that arrived twice would
   * pay twice; and it spawns `claude` in a directory the CLIENT named, which is
   * the asymmetry `containRepoDir` exists to close.
   *
   * One at a time per repo — two assessments proposing different verdicts over
   * one list is a merge nobody can do on a phone — so a second is refused
   * `ok:false` with a sentence rather than queued behind the first.
   *
   * **`ids` is the cut the caller is asking about.** Additive, so
   * `PROTOCOL_VERSION` did not move for it: absent is the whole repo, which is what this
   * message meant before the field and what an older client still sends. The
   * backlog is the screen this is tapped from and every other count on it is a
   * filter — a button that alone meant "all 62" while the list above it said
   * "6 of 62" was the one control whose number was not its own tap.
   *
   * They narrow what may be JUDGED. The finished rows that go in as context are
   * not narrowed: they are evidence for the verdicts, not candidates for one,
   * and `cleanAssessment` already refuses any verdict that names one.
   *
   * A scope naming nothing this repo can assess is refused `ok:false` with a
   * sentence — never silently widened to the repo, which is the one failure
   * that would spend an agent on nine times the question asked.
   */
  | ({ t: "assess.run"; repoDir: string; ids?: string[]; ackId?: string } & SendStamp)
  /**
   * Apply exactly these approvals. Durable, and the ackId is doing real work
   * here: applying a merge POSTS a prompt, and a replay that posted it twice
   * would put two agents on one job in one worktree.
   *
   * Everything not named in `choices` stays exactly as it is, and nothing is
   * deleted either way — a retired row keeps its words and the evidence it was
   * retired on.
   */
  | ({ t: "assess.apply"; runId: string; choices: AssessChoices; ackId?: string } & SendStamp)
  /**
   * Throw one proposal away without applying any of it.
   *
   * Deliberately NOT durable and never queued offline, for `intent.cancel`'s
   * reason: a discard delivered an hour late throws away a proposal the person
   * has since been reading.
   */
  | { t: "assess.discard"; runId: string }
  /** What this repo's newest run is (host replies `assess.state`). With
   *  `repoDir` omitted: one frame per repo that has ever been assessed. */
  | { t: "assess.state"; repoDir?: string }
  // ── Fan-out ──
  /** Run one prompt in N repos at once — a FRESH session per dir, same text fed
   *  into each. `dirs` are worktree paths; the host only accepts discovered repos.
   *  `ackId` (optional): durable-op receipt — see `op.ack`. The one message where
   *  a duplicate is most expensive: a re-send would spawn the whole sweep twice. */
  | ({ t: "fanout.run"; dirs: string[]; text: string; launch?: LaunchOpts; budget?: SessionBudget; cols?: number; rows?: number; ackId?: string } & SendStamp)
  /** Send another instruction into the sessions a run already spawned. `dirs`
   *  narrows it to a subset of the run's targets (omitted = every target whose
   *  session is still alive). NEVER spawns anything — a dead target is skipped.
   *  `ackId` (optional): durable-op receipt — see `op.ack`. */
  | ({ t: "fanout.followup"; runId: string; text: string; dirs?: string[]; ackId?: string } & SendStamp)
  /** Re-send the recent fan-out runs (on connect / sheet open). */
  | { t: "fanout.list" }
  // ── Auto-download (repo → phone) ──
  /** Fetch a repo's auto-pull rule (host replies `pull.config`). */
  | { t: "pull.get"; repoDir: string }
  /** Persist a repo's auto-pull rule. */
  | { t: "pull.save"; repoDir: string; config: AutoPullConfig }
  /** Re-send the queued pull items (on connect / sheet open). */
  | { t: "pull.list" }
  /** Queue one artifact by hand — "send this file to my phone" from the gallery. */
  | { t: "pull.add"; repoId: string; relPath: string }
  /** Drop one queued item, or the whole queue when `id` is omitted. */
  | { t: "pull.dismiss"; id?: string }
  // ── Scheduled prompts ──
  /** Re-send the schedule list (on connect / sheet open). */
  | { t: "schedule.list" }
  /**
   * Create or replace one schedule. Upsert by `entry.id`, which the CLIENT mints:
   * a re-send of the same edit overwrites rather than adding a second copy of
   * "every Thursday". Durable (`ackId`) so a schedule written on a train is
   * queued like a prompt instead of being lost with the tab — the idempotent id
   * is what makes replaying it safe.
   */
  | ({ t: "schedule.save"; entry: ScheduleEntry; ackId?: string } & SendStamp)
  | { t: "schedule.remove"; id: string }
  | { t: "schedule.setEnabled"; id: string; enabled: boolean }
  /**
   * Let the NEXT occurrence go by, then carry on as scheduled.
   *
   * Not the same verb as `setEnabled(false)`, which is an open-ended pause a
   * person has to remember to undo — this one spends the pending occurrence and
   * re-arms the one after it, so a rule you want to sit out exactly once does
   * not depend on your coming back. Recurring rules only: for a `once` the verb
   * that means this is delete.
   */
  | { t: "schedule.skipNext"; id: string }
  /**
   * Fire one now, off-schedule ("run it, don't wait for Thursday"). A real
   * sweep — N sessions — so it is a DURABLE op: the same ackId must never spawn
   * the fan-out twice, exactly like `fanout.run`.
   */
  | ({ t: "schedule.run"; id: string; ackId?: string } & SendStamp)
  // ── The durable Intent ──
  //
  // One store, one lifecycle, one "why is this waiting" sentence — the host's
  // answer to a phone that used to OWN undelivered work while being the least
  // reliable component in the system. Everything here is additive:
  // `PROTOCOL_VERSION` did not move for it, every message above keeps working through an
  // adapter, and a host that has never heard of these ignores them (an unknown
  // `t` is a no-op by design).
  /**
   * Write this down and take ownership of it.
   *
   * Durable, and the receipt means something stronger than the other ops': `ok`
   * is not sent until the row is on the desktop's DISK. That is the moment the
   * phone may forget the words, which is the whole promise, so the ordering
   * (store → ack ledger → socket) is part of the contract rather than an
   * implementation detail.
   *
   * At-most-once has two independent guards, because they cover different
   * failures: the `ackId` ledger catches a retry inside 45 minutes, and
   * `intent.id` catches one that outlives it — a post replayed a day later finds
   * the row and returns it rather than doing the work again. `op.ack` answers
   * with `intentId`, and with `launchId` too when the intent is a parked create,
   * so a client written against the old handover keeps working unchanged.
   */
  | ({ t: "intent.post"; intent: IntentDraft; ackId?: string } & SendStamp)
  /** Run it now, whatever its trigger says. Durable: "run it now" delivered
   *  twice is the sweep running twice. A recurring `at` intent does NOT spend
   *  its occurrence here — testing Thursday's sweep on Tuesday must not eat
   *  Thursday. */
  | ({ t: "intent.run"; id: string; ackId?: string } & SendStamp)
  /**
   * Put a FAILED row back in the queue, keeping its words, its place and the
   * failure it had.
   *
   * Not `intent.post` with the same text — that is a second row, and the first
   * one's history, order and origin stay behind on a terminal row nobody reads
   * again. Not `intent.run` either: that fires the row NOW, past every rung the
   * ladder exists to ask, when what was decided is only that the work is still
   * worth doing.
   *
   * Durable and at-most-once per `ackId`, like `intent.run`, because it is a
   * decision about somebody's work and the phone that sent it may be on a
   * tunnel that drops.
   *
   * ── `failedAt`: WHICH failure the tapper saw ──────────────────────────────
   *
   * Unlike `intent.cancel` this may be delivered LATE — but "the row is still
   * `failed`" is not what makes that safe, and saying so was wrong. `failed` is
   * a STATE, not an event, and the same row can be in it twice over two
   * different failures. The sequence that gets past a state-only guard:
   *
   *   1. the row fails (F1) and the phone draws that failure;
   *   2. the phone is offline; the person reads F1, taps *run it again*, and
   *      the op sits in the queue;
   *   3. meanwhile the assessment, or Activity's *run it now*, revives the row
   *      on the desktop; it runs, and it fails differently (F2);
   *   4. the tunnel comes back, the frame lands, the row is `failed` — so a
   *      state-only guard accepts it and runs the work again.
   *
   * Nobody decided that. The decision was taken against F1, which nobody has
   * read since, and the person's next sight of the row is a run they did not
   * ask for over a failure they never saw. So the op names the failure it was
   * taken against — `Intent.settledAt`, the instant the row the tapper was
   * looking at settled — and the host refuses a mismatch rather than reviving
   * on the strength of a state.
   *
   * This is `expectPrompt`'s posture exactly, one store over: an answer names
   * the question it answers, a mismatch is refused with nothing written, and
   * being refused is what makes sending it from a tunnel that drops safe. And
   * its posture on ABSENCE too — **absent means an older client that cannot
   * say, and is accepted** on the state guard alone. That is the pre-existing
   * behaviour, kept deliberately: a phone pinned to an old bundle must not lose
   * the button, and the hole it leaves is the one that was there before. A
   * client that CAN say always says.
   *
   * Additive: `PROTOCOL_VERSION` did not move for it, and a host that has never heard of
   * this ignores it, the same as every other `intent.*` message.
   */
  | ({ t: "intent.requeue"; id: string; failedAt?: number; ackId?: string } & SendStamp)
  /**
   * Lift ONE rung of the ladder for one row — today only `budget`
   * (`Intent.pastBudget`): the row still waits its turn behind `serial`,
   * `holdForHost`, the automatic-session slots and the smart pick. The bulk
   * *let past the budget* sent `intent.run` per row once, and `runNow` skips
   * the whole ladder, so four rows in one worktree started in parallel.
   *
   * The HOST scopes it: the waiver lasts until the latest reset among the
   * ceilings tripped when it lands (`budgetWaiverUntil`), so it is an answer
   * about THIS budget window and never about the next one. `on: false` is the
   * undo. Refused in words on a row that is starting, running, terminal or
   * archived, on any other `rung`, and when the budget holds nothing or cannot
   * say when its window resets. The client sends it live
   * only (its precondition — the budget holding the row — is a live fact);
   * the host route is durable like `intent.update`. Additive: an older host
   * ignores an unknown `t`, so the rows stay held — it fails CLOSED, which an
   * `intent.update` patch key would not (an old host acks an unknown key ok).
   */
  | ({ t: "intent.waive"; id: string; rung: "budget"; on: boolean; ackId?: string } & SendStamp)
  /** Change the words, the timing, or the flags of an intent that has not
   *  started. Durable for the receipt; idempotent by construction, since the
   *  patch carries absolute values. Refused on a row that is running or done. */
  | ({ t: "intent.update"; id: string; patch: IntentPatch; ackId?: string } & SendStamp)
  /** Aim it somewhere else — the "send it to this repo's work items instead"
   *  move, for a row whose session is gone. Same rules as `intent.update`. */
  //  `cwd` rides along because a re-aim across REPOS is one decision, not two:
  //  the backlog's own `update` always carried `repoDir` beside the session it
  //  was pointed at, and splitting them here would mean a phone sending two
  //  messages and a row that is briefly aimed at a session in another checkout.
  //  Absent ⇒ the repo is unchanged, which is the in-repo re-aim.
  | ({ t: "intent.retarget"; id: string; target: IntentTarget; cwd?: string; ackId?: string } & SendStamp)
  /** Call it off. Deliberately NOT durable and never queued offline, for the
   *  reason `launch.cancel` gives: a cancel delivered an hour late calls off
   *  work that has since run. */
  | { t: "intent.cancel"; id: string }
  /** "I have seen this one." The eviction gate: a terminal row may only leave
   *  the live file once a person has actually looked at it. */
  | { t: "intent.dismiss"; id: string }
  /** Re-send the whole list (on connect / sheet open). */
  | { t: "intent.list" };
