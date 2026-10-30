/**
 * The old vocabularies, spoken by the new store.
 *
 * `launch.ts` and `schedule.ts` are gone, but `launch.list`, `launch.cancel`,
 * `launch.run`, `schedule.save`, `schedule.list`, `schedule.setEnabled`,
 * `schedule.remove` and `schedule.run` are all still on the wire and still
 * answered — because the APK shell can pin an old bundle for weeks and because
 * the e2e scripts that pin those behaviours are the evidence that this move
 * changed nothing a user can see.
 *
 * So each of the two old shapes gets exactly two functions here: one that turns
 * it into an `IntentDraft`, and one that renders an intent back as the DTO the
 * client already knows. Nothing else in the host speaks either dialect.
 *
 * A launch and a schedule are the same object under this store, and that is the
 * point rather than a coincidence:
 *
 *   launch   = { target: repo+fresh, trigger: files }
 *   schedule = { target: repos | repo+fresh, trigger: at }
 *
 * Two files, two ticks and two lifecycle vocabularies were the difference
 * between them.
 */
import { basename } from "node:path";
import {
  DEFAULT_GRACE_MIN,
  LAUNCH_WAIT_MS,
  budgetPassAt,
  cleanAction,
  scheduleActionText,
  cleanRule,
  describeRule,
  intentPaused,
  isAgentWithdrawn,
  isTimedWorkRow,
  reopensConversation,
  ruleRecurs,
  type BacklogItem,
  type BacklogStatus,
  type BudgetPass,
  type BudgetWaiver,
  type BuildRun,
  type BuildRunStatus,
  type Intent,
  type IntentDraft,
  type ItemCategory,
  type LaunchIntent,
  type LaunchOpts,
  type LaunchState,
  type ScheduleAction,
  type ScheduleEntry,
  type SessionBudget,
} from "@waterplane/shared";
import { ORIGIN_SCHEDULE_BUILD, ORIGIN_SCHEDULE_SWEEP, ORIGIN_SCHEDULE_WORK } from "./manager.js";

// ── Launches ────────────────────────────────────────────────────────────────

/**
 * The five vocabularies as filters over one store.
 *
 * They used to be DEFINED here, which was right while the host was the only
 * reader of an `Intent`. It stopped being right when the phone became one: the
 * DTOs below are lossy — none of them carries `state`, `blockReason` or
 * `blockDetail` — so a client reading only DTOs had to reconstruct a lifecycle
 * the host had already decided. Now the classification lives in `@waterplane/shared`
 * beside the model it classifies, both ends use it, and the reconstruction is
 * deleted rather than kept in step. Re-exported so no host call site moved.
 */
export {
  isLaunchRow, isScheduleRow, isBacklogRow, isFanoutRow, isBuildRow, isAssessRow,
  isTimedWorkRow, timedWorkKey,
  intentKind, ORIGIN_FANOUT_RUN, ORIGIN_FANOUT_TARGET, ORIGIN_FANOUT_FOLLOWUP,
} from "@waterplane/shared";

/**
 * A `session.create` that names files it cannot run without.
 *
 * The id is the create op's own ackId, which is what makes a replayed op upsert
 * rather than park a second session, and what lets `op.ack` answer with the
 * same `launchId` both times.
 */
export function createToIntent(p: {
  id: string;
  cwd: string;
  prompt: string;
  needs: string[];
  now: number;
  cols?: number;
  rows?: number;
  title?: string;
  launch?: unknown;
  replaceSessionId?: string;
  budget?: SessionBudget;
}): IntentDraft {
  return {
    id: p.id,
    cwd: p.cwd,
    // A create carrying `needs` always carries the prompt that names them —
    // the paths are derived from the words. A bare open has nothing that can
    // fail to find its files, and is not parked at all (see `routes/session`).
    payload: { kind: "prompt", steps: [p.prompt] },
    target: { kind: "repo", fresh: true },
    trigger: { kind: "files", needs: p.needs, deadlineAt: p.now + LAUNCH_WAIT_MS },
    title: p.title,
    cols: p.cols,
    rows: p.rows,
    launch: p.launch,
    replaceSessionId: p.replaceSessionId,
    ...(p.budget ? { budget: p.budget } : {}),
  };
}

/**
 * One intent as the `LaunchIntent` a client already renders.
 *
 * The lifecycle mapping is where the two vocabularies meet, and only one arm of
 * it is interesting: `running` and `done` both render as `done`, because a
 * launch's `done` never meant "the turn finished" — it meant the session exists
 * and the first prompt was handed to `deliverPrompt`.
 */
export function intentToLaunch(i: Intent): LaunchIntent {
  const state: LaunchState =
    i.state === "starting" ? "opening"
      : i.state === "running" || i.state === "done" ? "done"
        : i.state === "failed" ? "failed"
          : i.state === "canceled" ? "canceled"
            : "waiting";
  const reason = i.state === "blocked" ? undefined : i.result?.detail || i.blockDetail;
  return {
    id: i.id,
    cwd: i.cwd,
    repoName: basename(i.cwd),
    prompt: i.payload.kind === "prompt" ? i.payload.steps[0] : "",
    needs: i.trigger.kind === "files" ? i.trigger.needs : [],
    createdAt: i.createdAt,
    deadlineAt: i.trigger.kind === "files" ? i.trigger.deadlineAt : i.createdAt + LAUNCH_WAIT_MS,
    state,
    sessionId: i.sessionId,
    missing: i.missing,
    // A launch that opened WITHOUT some of its files must keep saying which
    // ones: the prompt in that session still tells the agent to look at a path
    // that is not there, and somebody has to be able to work out why it could
    // not.
    reason: state === "done" && i.missing?.length
      ? `opened without ${i.missing.length === 1 ? basename(i.missing[0]) : `${i.missing.length} files`}`
      : reason,
    openedAt: state === "done" ? i.settledAt ?? i.startedAt : undefined,
    settledAt: i.settledAt,
    cols: i.cols,
    rows: i.rows,
    title: i.title,
    launch: i.launch,
    replaceSessionId: i.replaceSessionId,
  };
}

/** The legacy `launches.json`, converted. Only rows that were still WAITING
 *  carry work; a settled one is imported too, because its row is the only
 *  account of what happened to it. */
export function launchesToDrafts(raw: unknown[], now: number): IntentDraft[] {
  const out: IntentDraft[] = [];
  for (const v of raw) {
    const e = (v && typeof v === "object" ? v : {}) as Record<string, any>;
    const id = typeof e.id === "string" ? e.id.trim() : "";
    const cwd = typeof e.cwd === "string" ? e.cwd.trim() : "";
    const prompt = typeof e.prompt === "string" ? e.prompt : "";
    if (!id || !cwd || !prompt.trim()) continue;
    const createdAt = Number(e.createdAt) || now;
    out.push({
      id,
      cwd,
      payload: { kind: "prompt", steps: [prompt] },
      target: { kind: "repo", fresh: true },
      trigger: {
        kind: "files",
        needs: Array.isArray(e.needs) ? e.needs.filter((p: unknown) => typeof p === "string") : [],
        deadlineAt: Number(e.deadlineAt) || createdAt + LAUNCH_WAIT_MS,
      },
      title: typeof e.title === "string" ? e.title : undefined,
      cols: Number(e.cols) || undefined,
      rows: Number(e.rows) || undefined,
      launch: e.launch,
      replaceSessionId: typeof e.replaceSessionId === "string" ? e.replaceSessionId : undefined,
      ...{ createdAt },
    } as IntentDraft);
  }
  return out;
}

// ── Schedules ───────────────────────────────────────────────────────────────

/**
 * `keepAfterRun` as the save SAID it: `true` sets, `false` clears, and absent
 * is SILENCE — `undefined`, which `upsert()` reads as "unchanged" and carries
 * the stored one. Folding `false` and absent together made every re-save from
 * a sheet that never heard of the field a clear (bughunt 2026-10-29 BLD-1).
 *
 * `enabled` is deliberately NOT read here: it is derived from `nextAt` on the
 * way out (`intentToSchedule`) and every sheet sends `true` back, so it cannot
 * be a switch — pausing is `schedule.setEnabled`, and a pause survives a
 * re-save because `upsert()` carries it.
 */
function keepAfterRunOf(e: Record<string, any>): boolean | undefined {
  return e.keepAfterRun === true ? true : e.keepAfterRun === false ? false : undefined;
}

/**
 * One saved schedule, as an intent.
 *
 * The action maps DIRECTLY onto the intent's own target, which is the sentence
 * that made `schedule.ts` deletable: a fan-out is a `repos` target, a backlog
 * add is this repo. The one place it is not literal is that a backlog add takes
 * `fresh: true` — it needs no session to be ready, because the work item it
 * queues does that waiting itself — and is routed to the backlog by its
 * `origin`. See `ORIGIN_SCHEDULE_WORK`.
 *
 * `entry` is sanitized through `cleanEntry`'s own helpers first, so a rule from
 * a hand-edited file or a client one version ahead cannot get in unchecked.
 *
 * **The rule is carried WHOLE, both ways, and that is the only reason quiet
 * hours and the headroom guard need nothing here.** `hours` and `guardWindow`
 * are clauses on `ScheduleRule`, so they arrive inside `cleanRule(e.rule)` and
 * leave inside `intentToSchedule`'s `rule: i.trigger.rule` — there is no field
 * list in this file for them to be forgotten from. That is deliberate and it is
 * what a round trip is tested for (`intentsched.test.mjs`): the alternative,
 * naming each clause on the way past, is a file that silently drops whichever
 * one was added most recently, and a user whose "not before 07:00" vanished the
 * first time they edited the schedule's name.
 */
export function scheduleToIntent(raw: unknown, now: number): IntentDraft | null {
  const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const id = typeof e.id === "string" && e.id.trim() ? e.id.trim().slice(0, 40) : "";
  if (!id) return null;
  const action = cleanAction(e.action);
  if (!action) return null;
  const rule = cleanRule(e.rule);
  const g = Math.round(Number(e.graceMin));
  const graceMin = Number.isFinite(g) ? Math.min(7 * 24 * 60, Math.max(0, g)) : DEFAULT_GRACE_MIN;
  const name = typeof e.name === "string" && e.name.trim()
    ? e.name.trim().slice(0, 120)
    : scheduleActionText(action).split("\n")[0].slice(0, 120);
  // `waitUntilFree` is one tick on the sheet but two gates on the intent: this
  // repo (`serial`, already the store's own per-cwd rule) and the whole host
  // (`holdForHost`, new — see `IntentFacts.hostBusy`). Set together, never one
  // without the other, because a ticked box that only half-worked would look
  // exactly like this one did before it existed.
  const waitUntilFree = e.waitUntilFree === true;
  // ── A build rule ─────────────────────────────────────────────────────────
  //
  // The rule's own row holds WHICH build and WHICH values — never a command:
  // the command is resolved from the repo's `builds.json` at each occurrence,
  // by `BuildManager.fireScheduled`, through the same `run()` a tap uses, so a
  // later edit of the entry is what the next night runs and a deleted entry
  // fails in words. `postsScheduledBuild` (origin + payload) routes it; the
  // `shell` target is what every build row has, so rung 5 asks nothing of a
  // session it does not have.
  if (action.kind === "build") {
    return {
      id,
      cwd: action.repoDir,
      payload: { kind: "build" as const, buildId: action.buildId, ...(action.params ? { params: { ...action.params } } : {}) },
      target: { kind: "shell" as const },
      trigger: { kind: "at" as const, rule, graceMin, keepAfterRun: keepAfterRunOf(e) },
      title: name,
      createdAt: Number(e.createdAt) > 0 ? Number(e.createdAt) : now,
      origin: ORIGIN_SCHEDULE_BUILD,
      serial: waitUntilFree || undefined,
      holdForHost: waitUntilFree || undefined,
    } as IntentDraft;
  }
  // The CHAIN, if the action carries one. `steps[0]` repeats `text` by the same
  // contract `backlog.add` uses, so `[action.text]` is what an action without
  // one means and what every rule stored before the field existed means. Until
  // this line the send surface had to tell people their turns 2..n were being
  // dropped, because there was nowhere between here and `payload.steps` for
  // them to sit — see `SendSheet`/`dispatchIntent`'s `at` arm.
  const steps = action.kind === "backlog" && action.steps?.length ? [...action.steps] : [action.text];
  const base = {
    id,
    payload: { kind: "prompt" as const, steps },
    trigger: { kind: "at" as const, rule, graceMin, keepAfterRun: keepAfterRunOf(e) },
    title: name,
    createdAt: Number(e.createdAt) > 0 ? Number(e.createdAt) : now,
    serial: waitUntilFree || undefined,
    holdForHost: waitUntilFree || undefined,
  };
  if (action.kind === "backlog") {
    return {
      ...base,
      cwd: action.repoDir,
      target: { kind: "repo", fresh: true },
      origin: ORIGIN_SCHEDULE_WORK,
      label: action.label,
      // Default ON: a scheduled item that waits for a human tap is not a
      // schedule. `auto` is also what makes it budget-held, which is correct —
      // nobody is present at 03:00 to decide otherwise.
      auto: action.autoFire !== false,
      // The rule's own close-when-done answer, passed on to each occurrence's
      // item by `workItemInherits`. Absent stays absent (follow the global);
      // `upsert()` carries a stored one when an older bundle's save is silent.
      ...(typeof action.closeWhenDone === "boolean" ? { closeWhenDone: action.closeWhenDone } : {}),
      ...(action.flagWhenDone === true ? { flagWhenDone: true } : {}),
      // The budget each occurrence's session is born with, the same way —
      // `null` included: that is a person CLEARING it, which `upsert()` honours.
      ...(action.budget !== undefined ? { budget: action.budget } : {}),
      // The model each occurrence's session starts with — the sweep arm's
      // rule below: absent is the desktop's new-session defaults.
      ...(action.launch ? { launch: action.launch } : {}),
    } as IntentDraft;
  }
  return {
    ...base,
    // A sweep has no single repo; its first target is the nominal cwd, which is
    // what the row names itself by. Nothing reads it as a working directory —
    // every dir a sweep touches is in `target.dirs` and is validated there.
    cwd: action.dirs[0],
    target: { kind: "repos", dirs: action.dirs },
    origin: ORIGIN_SCHEDULE_SWEEP,
    launch: action.launch,
    ...(action.budget !== undefined ? { budget: action.budget } : {}),
  } as IntentDraft;
}

/**
 * An intent back as the `ScheduleEntry` the sheet edits — for the rows that
 * sheet can still say something true about.
 *
 * A non-`at` row was always `null` here: the schedules list is a view, and a
 * row it has no vocabulary for is not an entry with fields missing, it is not
 * an entry. **A TIMED WORK row is now the same answer for the same reason**
 * (`isTimedWorkRow`): a one-off aimed at one repo has no recurrence to pause,
 * no next occurrence to skip and no arm/disarm switch that means anything after
 * its one run — it is a backlog row wearing a clock, and it appears in
 * `backlog.list` carrying `BacklogItem.at`.
 *
 * **`scheduleToIntent` is deliberately unchanged, and so is `schedule.save`.**
 * The wire is untouched: an APK pinned to an old bundle still saves a one-off
 * through the schedule vocabulary and still gets its *saved · next run in 2h*
 * ack (which carries `intentId`). Only the row's CLASSIFICATION moved, which is
 * derived — so the same entry saved today and edited to *every week* tomorrow
 * walks back into this function with nothing migrated.
 */
export function intentToSchedule(i: Intent): ScheduleEntry | null {
  if (i.trigger.kind !== "at") return null;
  if (isTimedWorkRow(i)) return null;
  const text = i.payload.kind === "prompt" ? i.payload.steps[0] : "";
  const build = i.payload.kind === "build" && i.origin === ORIGIN_SCHEDULE_BUILD ? i.payload : null;
  // The chain rides back out as well as in. An edit of the rule's NAME goes
  // through this function and `scheduleToIntent` again, so a chain read back as
  // its first turn would vanish the first time somebody renamed the schedule —
  // the same silent drop the whole-rule round trip above is written to avoid.
  const chain = i.payload.kind === "prompt" && i.payload.steps.length > 1 ? [...i.payload.steps] : undefined;
  // A build rule rides back with its id AND its values, or renaming the rule
  // would leave it running the build with nothing picked.
  const action: ScheduleAction = build
    ? { kind: "build", repoDir: i.cwd, buildId: build.buildId, ...(build.params ? { params: { ...build.params } } : {}) }
    : i.target.kind === "repos"
    ? { kind: "fanout", dirs: i.target.dirs, text, launch: i.launch, ...(i.budget ? { budget: i.budget } : {}) }
    : {
      kind: "backlog", repoDir: i.cwd, text, label: i.label, autoFire: i.auto !== false, ...(chain ? { steps: chain } : {}),
      // Back out as well as in, or renaming the rule would drop it.
      ...(typeof i.closeWhenDone === "boolean" ? { closeWhenDone: i.closeWhenDone } : {}),
      ...(i.flagWhenDone ? { flagWhenDone: true } : {}),
      ...(i.budget ? { budget: i.budget } : {}),
      ...(i.launch ? { launch: i.launch } : {}),
    };
  return {
    id: i.id,
    name: i.title || scheduleActionText(action).split("\n")[0].slice(0, 120),
    // "Is anything armed": false for a PAUSED rule (`trigger.paused`, which
    // always comes with `nextAt: null`) and for a spent one-off alike. The
    // sheet tells the two apart by recurrence; the host by `intentPaused`.
    enabled: !intentPaused(i) && i.nextAt !== null,
    rule: i.trigger.rule,
    action,
    createdAt: i.createdAt,
    nextAt: i.nextAt ?? null,
    lastOccurrence: i.lastOccurrence,
    lastResult: i.result
      ? { at: i.result.at, ok: i.result.ok, detail: i.result.detail, occurrence: i.result.occurrence, late: i.result.late, childId: i.result.childId }
      : undefined,
    graceMin: i.trigger.graceMin,
    keepAfterRun: i.trigger.keepAfterRun,
    // Read back as one tick: `scheduleToIntent` only ever sets the pair
    // together, so either both are on or neither is — reading just one back
    // would silently drop the box's state the moment the other half lagged.
    waitUntilFree: i.serial === true && i.holdForHost === true ? true : undefined,
    running: i.state === "starting" || i.state === "running" ? true : undefined,
  };
}

/** The legacy `schedules.json`, converted. */
export function schedulesToDrafts(raw: unknown[], now: number): IntentDraft[] {
  const out: IntentDraft[] = [];
  for (const v of raw) {
    const draft = scheduleToIntent(v, now);
    if (!draft) continue;
    const e = v as Record<string, any>;
    // History belongs to the host: a spent occurrence must survive the move, or
    // the first tick after migration re-fires whatever already ran.
    // A legacy `enabled: false` on a standing rule was a person's pause, and
    // becomes the pause switch's flag; on a one-off it was "off", i.e. spent.
    const paused = e.enabled === false && draft.trigger.kind === "at" && ruleRecurs(draft.trigger.rule);
    out.push({
      ...draft,
      ...(paused && draft.trigger.kind === "at" ? { trigger: { ...draft.trigger, paused: true } } : {}),
      ...{
        lastOccurrence: Number.isFinite(Number(e.lastOccurrence)) ? Number(e.lastOccurrence) : undefined,
        nextAt: e.enabled === false ? null : undefined,
      },
    } as IntentDraft);
  }
  return out;
}

/** One line for logs and notifications: what fired, and on what rule. */
export function describeSchedule(i: Intent): string {
  const name = i.title || (i.payload.kind === "prompt" ? i.payload.steps[0].split("\n")[0].slice(0, 60) : i.id);
  return i.trigger.kind === "at" ? `${name} (${describeRule(i.trigger.rule)})` : name;
}

// ── The backlog ─────────────────────────────────────────────────────────────

/**
 * Rows the `backlog.*` messages speak for.
 *
 * There is no `origin` marker and deliberately so: a work item is not a special
 * KIND of intent, it is the plain one — prose, for this repo or one of its
 * sessions, to run as soon as that session can take it. Anything that fits that
 * description belongs in the backlog list whoever posted it, which is what makes
 * the sheet a view of the store rather than a second store with a view.
 *
 * The exclusions are the rows that have their own surface and would appear
 * twice: a parked create (`files`), a standing rule (`at`), a build, and a
 * fan-out's targets — those belong to their run.
 */
/** The check/validate verdicts, which are not lifecycle and do not live on the
 *  intent — see `review.ts`. Merged in here so the wire DTO still carries them
 *  exactly where `BacklogItem` did. */
export type ReviewSidecar = Partial<Pick<BacklogItem,
  "checkStatus" | "checkNote" | "checkDetail" | "checkedAt" |
  "validateStatus" | "validateNote" | "validateDetail" | "validateSteps" | "validatedAt">>;

/**
 * One intent as the `BacklogItem` a client already renders.
 *
 * The lifecycle mapping is where the two vocabularies meet, and the interesting
 * arms are the ends: `starting` is `running` (the item HAS been picked up — the
 * screen said "running" while `deliverPrompt` was typing long before this
 * store existed), and `canceled` is `failed`, because the backlog never had a
 * third terminal word and a row that vanished into an unknown status would be
 * the one thing this rework exists to prevent.
 */
export function intentToBacklogItem(i: Intent, review?: ReviewSidecar): BacklogItem {
  const status: BacklogStatus =
    i.state === "done" ? "done"
      : i.state === "failed" || i.state === "canceled" ? "failed"
        : i.state === "starting" || i.state === "running" ? "running"
          : "queued";
  const lastRequeue = i.requeues?.length ? i.requeues[i.requeues.length - 1] : undefined;
  return {
    id: i.id,
    text: i.payload.kind === "prompt" ? i.payload.steps[0] : "",
    status,
    repoDir: i.cwd,
    targetSessionId: i.target.kind === "session" ? i.target.sessionId : undefined,
    // Host-side fact, and the row's whole promise about a session that has
    // gone. `reopensConversation` is the one predicate (`@waterplane/shared`), so the
    // ladder, the executor and this chip cannot disagree about it.
    reopensConv: reopensConversation(i) || undefined,
    autoFire: i.pinned,
    label: i.label,
    sessionId: i.sessionId,
    // Read only beside the reason it belongs to (`Intent.blockSessionId`).
    holderSessionId: i.state === "blocked" && i.blockReason === "serial" ? i.blockSessionId : undefined,
    createdAt: i.createdAt,
    order: i.order ?? i.createdAt,
    startedAt: i.startedAt,
    finishedAt: i.settledAt,
    // A verdict is only an error when the row ENDED on it. A `retry` requeue
    // records its result too, and rendering that as the item's error would put
    // a red line on a row that is about to run perfectly well.
    error: status === "failed" ? i.result?.detail : undefined,
    // The LAST re-queue, flattened: how many times this row has been put back,
    // who put it back that time, and the failure it was carrying when they did.
    // The history itself (`Intent.requeues`, capped at `REQUEUE_KEEP`) stays on
    // the host — the row needs one sentence, not a list — and `n` is the whole
    // count rather than the kept slice's length being passed off as one, which
    // is the same posture `steps` takes: a number the phone can say out loud,
    // with the words behind it staying where nothing clips them.
    //
    // **`requeueCount` and NOTHING else, with no fallback.** This line read
    // `requeues.length` and was wrong from the sixth re-queue on: the list is
    // capped at `REQUEUE_KEEP`, so a row put back eleven times said "the 5th
    // time" for ever, on a chip a person reads as a warning. Falling back to the
    // length when the count is absent would put that same wrong number back for
    // exactly the rows that have been around longest — and absent is a shape the
    // wire already has a meaning for: `n` is optional, and a row nobody counted
    // says how many times it was put back by not saying.
    //
    // `error` is the entry's OWN result, not the row's: by the time this is read
    // the row is queued again, so `error` above is already absent, and the
    // failure a person is being asked about would otherwise have nowhere to be
    // shown. A carried result that says `ok` is not an error and is left out.
    requeued: lastRequeue
      ? {
        at: lastRequeue.at,
        by: lastRequeue.by,
        n: i.requeueCount,
        error: lastRequeue.result?.ok === false ? lastRequeue.result.detail : undefined,
      }
      : undefined,
    archived: i.archived,
    // A call-off is not a failure: the `canceled` arm of `status` above, said
    // precisely without a third terminal status (`BacklogItem.calledOff`).
    calledOff: i.state === "canceled" ? (isAgentWithdrawn(i) ? "agent" : "other") : undefined,
    manual: i.manual,
    // WHERE this one lands, for the row to say so rather than the sheet
    // inferring it from the absence of a `targetSessionId`. `fresh` is "a new
    // session of its own", `resume` is "…picking up the repo's last
    // conversation" — the two halves of the choice a person makes about context.
    fresh: i.target.kind === "repo" && i.target.fresh === true ? true : undefined,
    resume: i.resume,
    // The item's own close-when-done answer; absent = follows the global.
    closeWhenDone: i.closeWhenDone,
    flagWhenDone: i.flagWhenDone,
    // The budget the session it opens is born with; absent = none.
    budget: i.budget,
    // The model the session it opens starts on (`Intent.launch`, 9dea53cd);
    // absent = the new-session defaults.
    launch: i.launch,
    // A COUNT, never the chain: the row shows "3 steps" and the steps themselves
    // stay on the host in full (`payload.steps`), where nothing clips them.
    // Absent for the ordinary one-turn item rather than a `1` on every row.
    steps: i.payload.kind === "prompt" && i.payload.steps.length > 1 ? i.payload.steps.length : undefined,
    // A PERSON put this row where it is, so the row says so ("you placed this"). A rule the user cannot see is a rule
    // they cannot trust, which is why this crosses the wire at all.
    handOrdered: i.handOrdered,
    // What put this row here when it was not a person — `assess:<runId>`,
    // `retry:<id>`. Already capped at 40 chars by `cleanIntentRow`.
    origin: i.origin,
    // The CLOCK, on the one shape of row that has one and is still work
    // (`isTimedWorkRow`). The whole rule travels rather than a rendered
    // sentence, for `intentToSchedule`'s reason: quiet hours and the headroom
    // guard are clauses ON the rule, and a field list here is a list to forget
    // whichever one was added most recently from. `nextAt` is the row's own
    // armed instant — `null` is "nothing is armed", and it is never re-derived
    // here, because a second reading of "when does this fire" is a second
    // opinion about it.
    at: isTimedWorkRow(i) && i.trigger.kind === "at"
      ? { rule: i.trigger.rule, graceMin: i.trigger.graceMin, nextAt: i.nextAt ?? null }
      : undefined,
    // The host-wide half of *wait until it's free*. `serial` gets no field
    // because every repo-target item carries it by construction, so a row that
    // showed both would be saying one thing twice.
    holdForHost: i.holdForHost ? true : undefined,
    // A person let it past the budget, until that window resets; every other
    // wait still holds it. The phone hides one whose `until` has passed.
    pastBudget: i.pastBudget ? { until: i.pastBudget.until } : undefined,
    // ── What this row is CALLED, and who said so ──────────────────────────
    //
    // All four, and the AUTHORS are not an internal detail the phone could do
    // without: `itemHeadline` decides which string a row shows, and the author
    // is what decides whether the row may offer to re-title itself and whether
    // the next pass may write over what is there. A DTO carrying the value and
    // not the author would make the phone guess at both, which is the guess
    // this pair exists to remove. Copied straight across — the store cleaned
    // them PAIRWISE on the way in (`cleanIntentRow`) and re-deciding here would
    // be a second opinion about whose words these are.
    headline: i.headline,
    headlineBy: i.headlineBy,
    category: i.category,
    categoryBy: i.categoryBy,
    ...review,
  };
}

/**
 * A new work item, as an intent.
 *
 * Four decisions ride on the row: WHERE (a named session, or — the default now —
 * a session opened FOR this item), whether that new session picks up the repo's
 * last conversation (`resume`), whether the global auto-fire switch has a say
 * (`pinned` — see `Intent.pinned`), and the whole chain if there is one.
 *
 * `steps` is the WHOLE chain and `steps[0]` repeats `text`, so a caller that
 * knows nothing about chains still gets the one-turn item it always got. It is
 * ONE item carrying N turns rather than N items: `deliverChain` puts them on
 * separate turns in the order given, and N rows would have been N sessions.
 *
 * `serial` is set for a repo-target row and only for one, which is the whole of
 * "one at a time in this repo". It was free while every item in a repo shared
 * one session — rung 5 would not type a second prompt into a session already
 * holding an intent — and it stopped being free the moment each item opened its
 * own: nothing in the ladder would otherwise stop five due items in one repo
 * spawning five agents into one worktree at the same instant. A `session`-target
 * row does NOT get it: those still serialize on the session itself, and holding
 * them for the whole repo would make *queue here* wait on work it has nothing to
 * do with.
 */
export function backlogDraft(p: {
  id: string;
  cwd: string;
  text: string;
  label?: string;
  targetSessionId?: string;
  autoFire?: boolean;
  order: number;
  steps?: readonly string[];
  resume?: boolean;
  /** Close the session this item opens once done; absent follows the global
   *  setting (`Intent.closeWhenDone`). `false` is kept — it is an answer. */
  closeWhenDone?: boolean;
  /** Flag the session for follow up once done (`Intent.flagWhenDone`); absent = off. */
  flagWhenDone?: boolean;
  /** The budget the session this item opens is born with (`Intent.budget`).
   *  Meaningless on a row aimed at a live session, so it is dropped there. */
  budget?: SessionBudget;
  /** The model/effort/backend the session this item opens starts with
   *  (`Intent.launch`). Dropped on a row aimed at a live session, like the
   *  budget: that session is already running whatever it runs. */
  launch?: LaunchOpts;
  /**
   * The other half of *wait until it's free*, when the item is being created BY
   * a row that was ticked that way — a schedule, today (F14).
   *
   * Only one half travels, because the other is already here: a repo-target
   * item is `serial` by construction (below), so a schedule's `serial` is
   * satisfied before it is asked for. `holdForHost` is the flag that had
   * nothing to carry it. A schedule ticked *wait until it's free* whose action
   * is "add a backlog item" was holding the creation of the ROW — which is
   * instantaneous and never busy — and the item it created then fired into
   * whatever else the desktop was doing, with nothing holding it at all. The
   * tick gated the wrong event.
   */
  holdForHost?: boolean;
  /** A waiver a person already gave (`Intent.pastBudget`), window and all —
   *  carried by the row the HOST makes out of a row that had one: a
   *  recurring rule's child. */
  pastBudget?: BudgetWaiver;
  /** The before-reset lift a recurring rule's occurrence carries
   *  (`Intent.budgetPass`, stamped by `workItemInherits`). */
  budgetPass?: BudgetPass;
  /** A leftover of this reset week (`Intent.leftoverOf`) — host-written only;
   *  `intent.post` strips it off the wire. */
  leftoverOf?: number;
  /**
   * What to CALL the row, for the one caller that is making a row nobody typed:
   * an assessment posting a merge or a genuinely new item.
   *
   * `nameBy` travels with the pair rather than being defaulted here, because a
   * value with no author is a title that cannot say whether it may be replaced
   * (`naming.ts`) — and defaulting it would be this file deciding who wrote
   * something, which is the one thing nothing but a call site knows. Absent
   * `nameBy`, or absent words, and the row is posted with no name at all: that
   * is the honest shape for `add()`'s rows, where the words ARE the person's.
   */
  headline?: string;
  category?: ItemCategory;
  nameBy?: "assess" | "name";
}): IntentDraft {
  // `steps[0]` is `text` again by contract. A caller that sends a chain whose
  // head disagrees is trusted about the chain: the steps are what runs.
  const steps = p.steps?.length ? [...p.steps] : [p.text];
  return {
    id: p.id,
    cwd: p.cwd,
    payload: { kind: "prompt", steps },
    // `{ kind: "repo" }` normalises to `{ kind: "repo", fresh: true }` in
    // `cleanTarget`, which is where the retirement of the non-fresh repo target
    // is written down. Named bare here so there is one spelling of "this repo"
    // in the host and the normalisation stays the only place that decides.
    target: p.targetSessionId ? { kind: "session", sessionId: p.targetSessionId } : { kind: "repo" },
    // `idle` rather than `now`: a work item is deferred work by definition and
    // waits for its session to be free. The two are one behaviour in the ladder;
    // the word is what the row means.
    trigger: { kind: "idle" },
    auto: true,
    serial: p.targetSessionId ? undefined : true,
    holdForHost: p.holdForHost || undefined,
    pastBudget: p.pastBudget,
    budgetPass: p.budgetPass,
    leftoverOf: p.leftoverOf,
    pinned: p.autoFire || undefined,
    resume: p.resume || undefined,
    closeWhenDone: typeof p.closeWhenDone === "boolean" ? p.closeWhenDone : undefined,
    flagWhenDone: p.flagWhenDone === true ? true : undefined,
    ...(p.budget && !p.targetSessionId ? { budget: p.budget } : {}),
    ...(p.launch && !p.targetSessionId ? { launch: p.launch } : {}),
    label: p.label,
    order: p.order,
    // Pairwise or not at all, which is what `cleanIntentRow` would enforce on
    // the way in anyway — said here too so the draft that goes to `post()` is
    // already the shape the store keeps, rather than one it silently repairs.
    ...(p.nameBy && p.headline ? { headline: p.headline, headlineBy: p.nameBy } : {}),
    ...(p.nameBy && p.category ? { category: p.category, categoryBy: p.nameBy } : {}),
  };
}

/**
 * What a RECURRING schedule's *add a backlog item* action hands to the item it
 * creates, once per occurrence.
 *
 * Recurring is now the whole of its scope: a one-off with a backlog action is
 * an `isTimedWorkRow` and runs ITSELF (`manager.execute`), so it has no child
 * to hand anything to. A standing rule still does — the rule outlives each
 * occurrence, so each occurrence needs a row of its own to be the account of.
 *
 * A seam rather than three lines inside the executor, because it is the whole
 * of F14 and F14 was invisible: the parent row is where the tick is set and the
 * CHILD is where the work happens, so a gate that stays on the parent gates the
 * making of a row — instantaneous, never busy, always allowed — while the work
 * it was written for runs into whatever else the desktop was doing. Nothing on
 * a screen says so; the parent reports "queued" and is telling the truth.
 *
 * Three things travel and one deliberately does not. The CHAIN travels whole
 * (`steps`), because only `steps[0]` used to reach the child and a scheduled
 * three-step prompt silently became a one-step one. `resume` travels because it
 * is a statement about the conversation the work runs in, and `closeWhenDone`
 * beside it because it is a statement about the session that conversation is in. `holdForHost`
 * travels because nothing else carries it. `serial` does NOT need to: every
 * repo-target item is serial by construction (`backlogDraft`), so it is
 * satisfied before it is asked for — and a schedule aimed at a repo has no
 * other shape of child.
 *
 * `pastBudget` travels for `holdForHost`'s reason: a person who let the rule
 * past the budget meant the WORK, and the work is the child — with the same
 * `until`, so the child is let past THAT window and no later one. The parent's
 * own waiver is cleared once the fire that mints the child returns
 * (`manager.fire`), so it covers exactly this one occurrence.
 *
 * `budgetPass` travels too, and is STAMPED rather than inherited as a flag: a
 * `before`-edge window rule's occurrence may run past that window's ceiling
 * until the reset it was timed ahead of (`budgetPassOf` on the parent's own
 * clock). The child has no clock to read it off, so it gets the occurrence and
 * the reset from `lastOccurrence` — written before the executor, so it IS the
 * occurrence being fired — or the cap the parent was exempt from would hold
 * the work it was exempt for. Nothing for any other rule.
 */
export function workItemInherits(i: Intent): { steps: readonly string[]; resume?: boolean; closeWhenDone?: boolean; flagWhenDone?: boolean; budget?: SessionBudget; launch?: LaunchOpts; holdForHost?: boolean; pastBudget?: BudgetWaiver; budgetPass?: BudgetPass } {
  return {
    steps: i.payload.kind === "prompt" ? i.payload.steps : [],
    resume: i.resume,
    // The rule said what becomes of the session each occurrence opens, and the
    // occurrence's ITEM is what opens it — so the answer travels with `resume`.
    closeWhenDone: i.closeWhenDone,
    flagWhenDone: i.flagWhenDone,
    // …and so does the budget that session is born with, and its model.
    budget: i.budget,
    launch: i.launch,
    holdForHost: i.holdForHost,
    pastBudget: i.pastBudget,
    budgetPass: i.trigger.kind === "at" && i.lastOccurrence != null
      ? budgetPassAt(i.trigger.rule, i.lastOccurrence) ?? undefined
      : undefined,
  };
}

/**
 * The legacy `<repoDir>/.waterplane/backlog.json`, converted.
 *
 * Everything is carried: a settled item keeps its verdict and its timestamps,
 * because that row is the only account of what happened to it. The two fields
 * that are NOT carried are the two the old loader already dropped on every
 * boot — a per-boot `targetSessionId` and the per-item auto flag that was bound
 * to it — for the reason it gave: they meant "in THAT session", and that
 * session died with the process that wrote the file.
 */
export function backlogToDrafts(raw: unknown, repoDir: string | null, now: number): IntentDraft[] {
  const items = (raw && typeof raw === "object" ? (raw as { items?: unknown }).items : null);
  if (!Array.isArray(items)) return [];
  const out: IntentDraft[] = [];
  for (const v of items) {
    const e = (v && typeof v === "object" ? v : {}) as Record<string, any>;
    const id = typeof e.id === "string" ? e.id.trim() : "";
    const text = typeof e.text === "string" ? e.text : "";
    // `repoDir` null is the pre-per-repo GLOBAL store, whose rows name their own
    // repo. One that names none could never be placed and was dropped then too.
    const cwd = repoDir ?? (typeof e.repoDir === "string" ? e.repoDir.trim() : "");
    if (!id || !text.trim() || !cwd) continue;
    const createdAt = Number(e.createdAt) || now;
    // `running` was never resumable across a restart and the old loader said so
    // by resetting it; a settled one keeps the word it settled on.
    const state = e.status === "done" ? "done" : e.status === "failed" ? "failed" : "queued";
    out.push({
      id,
      cwd,
      payload: { kind: "prompt", steps: [text] },
      target: { kind: "repo" },
      trigger: { kind: "idle" },
      auto: true,
      // Same rule an item added today gets, and for the same reason: an imported
      // repo of thirty queued rows must not answer the first tick by opening
      // thirty sessions in one worktree.
      serial: true,
      label: typeof e.label === "string" ? e.label : undefined,
      order: Number.isFinite(Number(e.order)) ? Number(e.order) : createdAt,
      archived: e.archived === true ? true : undefined,
      ...{
        createdAt,
        state,
        startedAt: Number(e.startedAt) || undefined,
        settledAt: Number(e.finishedAt) || undefined,
        result: state === "queued" ? undefined : {
          at: Number(e.finishedAt) || createdAt,
          ok: state === "done",
          detail: typeof e.error === "string" && e.error ? e.error : state === "done" ? "done" : "did not run",
        },
      },
    } as IntentDraft);
  }
  return out;
}

/** The check/validate fields of a legacy item, which move to the review
 *  sidecar rather than onto the intent — they are verdicts about work that has
 *  settled, not lifecycle. */
export function backlogReviews(raw: unknown): Record<string, ReviewSidecar> {
  const items = (raw && typeof raw === "object" ? (raw as { items?: unknown }).items : null);
  const out: Record<string, ReviewSidecar> = {};
  if (!Array.isArray(items)) return out;
  for (const v of items) {
    const e = (v && typeof v === "object" ? v : {}) as Record<string, any>;
    const id = typeof e.id === "string" ? e.id.trim() : "";
    if (!id) continue;
    const side: ReviewSidecar = {};
    for (const k of ["checkStatus", "checkNote", "checkDetail", "checkedAt", "validateStatus", "validateNote", "validateDetail", "validateSteps", "validatedAt"] as const) {
      if (e[k] !== undefined) (side as Record<string, unknown>)[k] = e[k];
    }
    if (Object.keys(side).length) out[id] = side;
  }
  return out;
}

// ── Fan-out ─────────────────────────────────────────────────────────────────

/** `fanoutRuns` MOVED to `@waterplane/shared` — the phone rebuilds runs from the same
 *  rows now, so the aggregate is computed once from one implementation instead
 *  of being projected here and shipped alongside the rows it came from. */
export { fanoutRuns } from "@waterplane/shared";

// ── Builds ──────────────────────────────────────────────────────────────────

/**
 * One intent as the `BuildRun` the sheet streams output into.
 *
 * `runId` is the intent id, which is what keeps `build.output` frames — keyed by
 * run — unchanged on the wire. The name, command and working dir come off the
 * payload rather than off today's `builds.json`, because a run row that renames
 * itself when the config is edited is a lie about what ran.
 */
export function intentToBuildRun(i: Intent): BuildRun {
  const p = i.payload.kind === "build" ? i.payload : { buildId: "", name: undefined, cmd: undefined, cwd: undefined, params: undefined };
  const status: BuildRunStatus =
    i.state === "done" ? "done"
      : i.state === "canceled" ? "cancelled"
        : i.state === "failed" ? "failed"
          : "running";
  return {
    runId: i.id,
    repoDir: i.cwd,
    buildId: p.buildId,
    name: p.name || i.title || "build",
    cmd: p.cmd || "",
    cwd: p.cwd || i.cwd,
    status,
    exitCode: i.result?.exitCode ?? null,
    startedAt: i.startedAt ?? i.createdAt,
    finishedAt: i.settledAt,
    artifacts: i.result?.artifacts,
    // What this run was asked for. With parameters, two runs of one button are
    // two different builds, and the row is where that has to be legible.
    params: p.params,
  };
}
