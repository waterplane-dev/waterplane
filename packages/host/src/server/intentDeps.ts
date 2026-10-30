/**
 * The `IntentManager`'s deps literal — every seam the durable store is handed,
 * the executors included — and the cached listing of the dirs a sweep may name.
 *
 * Moved verbatim out of `main.ts` (M3 of the host split, see
 * docs/notes/host-architecture.md). Every main-scope name is read as
 * `ctx.<name>` at CALL time: the literal references `backlog`,
 * `fanout`, `builds`, `capture`, `assessExecutor`, `usage`, `budget` and
 * `intents` itself, all defined AFTER `new IntentManager(…)` in `main.ts`, and
 * is correct only because nothing invokes these closures during construction.
 * Never destructure `ctx` here.
 */
import { basename } from "node:path";
import { autoSlotsWaitText, budgetHoldText, isAutomaticOrigin, isCaptureRow, needsSlot, netRetryStalls, scheduleItemOrigin, sessionBudgetHeld, sessionOriginOfIntent, waitedSessionName, LOCAL_SESSIONS_KEY, type Intent, type LaunchOpts } from "@waterplane/shared";
import { BACKLOG_SESSIONS_MAX, REAP_CEILING_MS, chainDeliveryError, isBacklogTitle, retryableStep } from "../backlog.js";
import { intentToCaptureRun } from "../capture.js";
import { FANOUT_CONCURRENCY } from "../fanout.js";
import type { IntentDeps } from "../intents/manager.js";
import {
  ORIGIN_FANOUT_FOLLOWUP,
  ORIGIN_FANOUT_TARGET,
  fanoutRuns,
  intentToBuildRun,
  isBacklogRow,
  isBuildRow,
  isFanoutRow,
  isScheduleRow,
  workItemInherits,
} from "../intents/adapters.js";
import { hostStateDir } from "../branddirs.js";
import { readJsonGuardedDetail, writeTextAtomic } from "../jsonstore.js";
import { discoverTargets } from "../repos.js";
import { installLocalSlots, localModelHold, localSlotsDetail, localSlotsPass, localStartNotice } from "../localslot.js";
import { ranVerdict } from "../settle.js";
import { haltRefusal } from "../halt.js";
import type { ServerCtx } from "./ctx.js";

/**
 * The durable Intent store — one file, one tick, one lifecycle for every piece
 * of deferred work this host owns.
 *
 * It replaces `schedule.ts` and `launch.ts`, which were the same 240 lines
 * twice (launch's own header admitted as much) and which each got the two hard
 * rules right in isolation: at-most-once by a client-minted id, and the
 * mutating state persisted BEFORE the side effect. What they were wrong about
 * is that there were two of them — two files, two poll loops, two lifecycle
 * vocabularies, and two places for a piece of work to be lost.
 *
 * This file stays the join between WHEN and WHAT, exactly as it was for both
 * managers: the store owns the clock, the persistence and every state
 * transition, and the executors below own only the doing. A scheduled sweep
 * still goes through `fanout.start()` like a tapped one — same dir validation,
 * same run rows in the sheet — because a schedule is a caller, not a second
 * implementation of the sweep.
 */
export function makeIntentDeps(ctx: ServerCtx): IntentDeps {
  /**
   * The dirs a sweep may legally name, cached.
   *
   * `discoverTargets` walks the root, so a tick that asked it every two seconds
   * would make the store the most expensive thing on the machine. The tick only
   * awaits this when a `repos`-target intent is actually pending, and a scan that
   * has never succeeded answers `null` rather than an empty set — the store then
   * declines to judge a sweep at all, instead of failing it on a listing that does
   * not exist. An empty listing that DID come back is a real answer and is passed
   * through as one.
   */
  let knownDirsCache: { at: number; dirs: Set<string> | null } = { at: 0, dirs: null };
  async function knownRepoDirs(): Promise<Set<string> | null> {
    if (knownDirsCache.dirs && Date.now() - knownDirsCache.at < 30_000) return knownDirsCache.dirs;
    try {
      const targets = await discoverTargets(ctx.ROOT);
      knownDirsCache = { at: Date.now(), dirs: new Set(targets.map((t) => t.worktreePath)) };
    } catch { /* keep the last listing: a failed scan is not evidence a repo is gone */ }
    return knownDirsCache.dirs;
  }

  // The local-model gate the three deps below read (`localslot.ts`): which
  // sessions and rows run on a local model, the synced cap, and a kick when a
  // model finishes loading. Every closure reads `ctx` when CALLED — `intents`
  // and `settings` are assigned after this factory runs.
  installLocalSlots({
    sessions: () => ctx.sessions.list().map((s) => ({
      id: s.id, running: s.running, backend: s.backend, model: s.model, turnActive: s.turnActive,
      name: waitedSessionName(s, ctx.sessions.originOf(s.id)?.itemLabel),
    })),
    rows: () => ctx.intents.list(),
    setting: () => ctx.settings?.get(LOCAL_SESSIONS_KEY)?.value,
    kick: () => ctx.intents.kick(),
  });

  return {
    root: ctx.ROOT,
    stateDir: hostStateDir(ctx.ROOT),
    // The guarded read moves a corrupt intents.json aside; the write is atomic (`intents/disk.ts`).
    files: { readGuarded: readJsonGuardedDetail, writeText: (path, body) => writeTextAtomic(path, body) },
    // `laneBusy` wants `limitBlocked` and `promptKind`, which live one level down
    // on `SessionInfo`. Handing it a raw SessionInfo type-checks and quietly
    // answers "not busy" for a session parked on a question — exactly the state
    // the rule exists to wait out. `turnActive` additionally carries
    // `autoFireBlocker`'s answer, which is the only place the silence heuristic
    // for an UNHOOKED session lives: the more specific reasons below it (limit, a
    // question box) still win, because `sessionBlocker` checks them first.
    sessions: () => ctx.sessions.list().map((s) => {
      const origin = ctx.sessions.originOf(s.id);
      return {
        id: s.id, cwd: s.cwd, running: s.running, turnStartedAt: s.turnStartedAt,
        turnActive: s.turnActive || (s.running && ctx.sessions.autoFireBlocker(s.id, ctx.backlog.idleMs) !== null) || undefined,
        limitBlocked: s.limit?.blocked, promptKind: s.prompt?.kind, awaitingInput: s.awaitingInput,
        convId: s.claudeSessionId,
        // Opened for QUEUED work — the only kind of session the serial rung
        // lets hold a repo (`intentSerialHolders`). The origin is the fact; the
        // `backlog · ` title mark is the same fact for a session whose live
        // record predates origins (and the one the cap already counts).
        automatic: isAutomaticOrigin(origin) || isBacklogTitle(s.title) || undefined,
        // A turn that ended on a question in prose: an automatic predecessor
        // that asked one holds the row behind it, like a box does.
        asking: s.asking ? true : undefined,
        // Work here is STALLED on the API: the serial sentence says so ("waiting
        // behind a stalled item") instead of naming a job that never moves.
        netStalled: netRetryStalls(s.netRetry) || undefined,
        // What the serial sentence calls it ("waiting for 'fix webkit sync'"):
        // the derived tab name, else the item it was opened for, else its first
        // prompt — the bare repo title only when nothing else exists.
        name: waitedSessionName(s, origin?.itemLabel),
      };
    }),
    sessionAlive: (id) => ctx.sessions.get(id)?.running === true,
    // The conversation, not the process: `claudeSessionId` is what `--resume`
    // takes and what outlives the session a row was aimed at. Absent for a
    // backend whose id is not a claude conversation, which is exactly when the
    // store must not write one down.
    convIdFor: (id) => ctx.sessions.get(id)?.claudeSessionId ?? null,
    // Which session a `{kind:"repo"}` intent resolves to is the BACKLOG's answer,
    // and it is now injected rather than guessed at a second time: one
    // implementation of "automatic work never adopts a session you opened by
    // hand, a hand fire may, and the repo's own session is followed across a
    // usage-limit bounce".
    repoSession: (cwd, adopt) => ctx.backlog.resolveRepoSession(cwd, adopt),
    // The cap, as a fact rather than as a refusal string. Every fired work item
    // opens a session of its OWN now, so the thing that has to be bounded is how
    // many of those may be alive at once — one `claude` is one real process and one
    // real share of the account — counted while WORKING, an idle one left open holds none — and a host that has been away for a week must not
    // answer a pile of due work by spawning a dozen agents. The ladder's `noSlot`
    // rung reads this; nothing here refuses anything.
    // `startingSlotCount` adds the sessions being OPENED right now: a plugin backend's
    // `create()` awaits `prepare()` before the session exists, and the fire is `void`, so a tick
    // inside that window would otherwise read a slot as free that is already spoken for (R4).
    autoSlotsFree: () => Math.max(0, BACKLOG_SESSIONS_MAX - ctx.backlog.autoSessionCount()
      - startingSlotCount(ctx.intents.list(), (id) => ctx.sessions.get(id)?.running === true)),
    // …and the numbers for the sentence, which only this side knows (the pure rule
    // is handed the difference, never the ceiling). Same shape as `budgetDetail`.
    // The wording is `autoSlotsWaitText`'s (shared, one sentence for both
    // ends). Only a WORKING automatic session holds a slot (`slotBusy`), so a
    // slot frees itself when one goes idle — nothing is closed to make room.
    autoSlotsDetail: () => autoSlotsWaitText(ctx.backlog.autoSlotFacts()),
    // The local-model gate (`localslot.ts`): the cap on local coding turns as a
    // rung (`localModel`), its sentence, and the model loaded before the fire.
    localSlots: () => localSlotsPass(),
    localSlotsDetail: () => localSlotsDetail(),
    localHold: (row) => localModelHold(row),
    // EXACTLY the session that replaced the one that died, never "the newest one
    // in that directory". See `SessionManager.revivedSessionFor`.
    revivedSessionFor: (deadId) => ctx.sessions.revivedSessionFor(deadId),
    diedAtLimit: (id) => ctx.sessions.diedAtLimit(id),
    stopCount: (id) => ctx.sessions.stopCount(id),
    isHooked: (id) => ctx.sessions.isHooked(id),
    turnHookSeen: (id) => ctx.sessions.sawTurnHook(id),
    // A pane in copy-mode forwards no live bytes, so its silence is a frozen view
    // and not a finished turn: null ("no reading") rather than a growing number.
    // The store is this dep's only reader.
    sessionIdleMs: (id) => (ctx.sessions.inCopyMode(id) ? null : ctx.sessions.idleMs(id)),
    sessionHasPrompt: (id) => !!ctx.sessions.get(id)?.prompt,
    idleWindowMs: () => ctx.backlog.idleMs,
    reapCeilingMs: () => REAP_CEILING_MS,
    sessionNetStalled: (id) => netRetryStalls(ctx.sessions.get(id)?.netRetry),
    groupConcurrency: () => FANOUT_CONCURRENCY,
    knownDirs: knownRepoDirs,
    // The reset instants and percentages a `window` rule is measured against.
    // Whatever `usage.ts` has cached RIGHT NOW, nulls included — an unread reset
    // arms nothing and an unread percentage skips, and both of those decisions
    // belong to the pure rules rather than to this seam.
    usageWindows: () => {
      const u = ctx.usage.get();
      return { sessionResetAt: u.sessionResetAt, weeklyResetAt: u.weeklyResetAt, sessionPct: u.sessionPct, weeklyPct: u.weeklyPct, periodResetAt: ctx.budget.periodResets() };
    },
    budgetBlocked: () => ctx.budget.verdict().blocked,
    // The first tripped ceiling's sentence, and every one of them for the rung
    // that lifts a before-reset row past its own window's cap.
    budgetDetail: () => {
      const c = ctx.budget.ceilings()[0];
      return c ? budgetHoldText(c, Date.now()) : undefined;
    },
    budgetOver: () => ctx.budget.ceilings(),
    leftoverOver: () => ctx.budget.leftover(),
    // The sessions whose OWN budget is spent — the one shared predicate, so a
    // row aimed at one waits exactly when the phone's queue holds it.
    budgetHeldSessions: () => new Set(ctx.sessions.list().filter(sessionBudgetHeld).map((s) => s.id)),
    autoFire: () => ctx.backlog.getAuto(),
    halted: haltRefusal, // the emergency halt: nothing fires, nothing is spent (`halt.ts`)
    // Restart reconciliation's evidence: a backend's own channel, else the CLI's
    // own conversation log, which outlives both the session and this process.
    logVerdict: (sessionId, text, since, claimer) => ranVerdict(ctx.sessions, sessionId, text, since, { claimer }),
    executors: {
      // A parked create, opened at last. Everything about it is the ordinary
      // path — the same `sessions.create()` and the same at-most-once
      // `startPrompt()` a tapped create runs — because the store owns WHEN.
      async freshSession(i) {
        // One repo of a SWEEP is a fresh session too, and it is the fan-out that
        // owns what a target's delivery means — the one-shot retry for a session
        // that has just booted, and the refusal to guess a completion from
        // silence. Routed on `origin`, the same way the schedule's work-item
        // action is: the target shape is identical, the meaning is not.
        if (i.origin === ORIGIN_FANOUT_TARGET) return ctx.fanout.runTarget(i);
        // Same atomic relaunch semantics a direct create has: killing the old
        // session is part of the op, not a separate write that could be lost.
        if (typeof i.replaceSessionId === "string") ctx.sessions.kill(i.replaceSessionId, undefined, "replaced");
        const steps = i.payload.kind === "prompt" ? i.payload.steps : [];
        // ── A work item, in a session opened FOR it ──────────────────────────
        //
        // The one branch that AWAITS its delivery, and the reason it is a branch
        // rather than a second executor is `deliver.ts`: there is exactly one
        // implementation of "type into a live session like a human and confirm",
        // and this reaches it through the same `startPrompt` + `deliverChain` the
        // rest of the host uses. The four verdicts, the wording for each of them
        // (`deliveryError`) and the "only `retry` may be re-attempted" rule are the
        // backlog's own and are not restated here.
        //
        // A parked create (`files`) and a scheduled sweep fall through to the old
        // path below on purpose: a launch's `done` has never meant "the turn
        // finished", it means the session exists and the prompt was handed over,
        // and changing that would rewrite what every parked create reports.
        if (isBacklogRow(i)) {
          let sessionId: string;
          // A person's tap past the local cap is TOLD, never held: an
          // automatic row only reaches here with the cap free, so a sentence
          // here means somebody pressed "run now" (`localslot.ts`).
          const localOver = localStartNotice(i.launch, { rowId: i.id });
          try {
            sessionId = await ctx.backlog.openItemSession(i);
          } catch (err) {
            // `spawnFailure` already turned a bare `posix_spawnp failed.` into a
            // sentence about the pty table. Carry it, and mark it retryable: the
            // session never existed, so provably nothing was typed.
            return { ok: false, detail: String((err as Error)?.message || err), retry: true };
          }
          ctx.recomputeWatched();
          // Said now, not at the end: delivery takes seconds and the row is
          // `starting` for all of them, so without this the phone shows an item in
          // flight with no session to open. It is also where the completion
          // baseline is taken — see `noteSession`.
          ctx.intents.noteSession(i.id, sessionId);
          const where = `${basename(i.cwd)} · a session of its own`;
          if (!steps.length) return { ok: true, detail: `opened a session in ${basename(i.cwd)}`, sessionId };
          let last = await ctx.startPrompt(sessionId, steps[0], { rescue: false });
          // Which STEP stopped, not only what happened to it — see below.
          let failedStep = 0;
          if (last === "ok" && steps.length > 1) {
            const tail = await ctx.deliverChain(sessionId, steps.slice(1));
            last = tail.last;
            failedStep = tail.step + 1;
          }
          if (last === "ok") {
            return { ok: true, detail: `ran in ${where}${localOver ? ` — ${localOver}` : ""}`, sessionId, watch: "turn" };
          }
          // `retry` sends the row back to the queue, which will open a SECOND
          // session for it — and the first one is left standing, deliberately. It
          // holds the only account of a TUI that never became typeable, which is
          // the thing somebody would want to look at; and it costs at most one
          // slot for `WATERPLANE_BACKLOG_REAP_IDLE_MS`, because a session with no row in
          // it, nobody attached and nothing printing is exactly what the reap
          // takes. Closing it here would trade a fact for a few seconds of cap.
          //
          // **And it may only be said of the FIRST step.** "Provably nothing was
          // typed" is a claim about the step that returned `retry`; for a chain,
          // step 1 has already run and a requeue would open a second session and
          // type it a second time, while the first session is still working on the
          // first copy. `retryableStep` holds that rule for both executors.
          return {
            ok: false, sessionId,
            // `step` as well as `retry`: the store's Stop shortcut is only valid
            // for step 0, because a Stop seen while step k was being delivered is
            // evidence that step 1 ran and nothing more. See `ExecutorResult.step`.
            step: failedStep,
            detail: chainDeliveryError(last, failedStep, steps.length),
            retry: retryableStep(last, failedStep),
          };
        }
        const info = await ctx.sessions.create(i.cwd, { cols: i.cols, rows: i.rows, title: i.title, launch: i.launch as LaunchOpts | undefined, resume: i.resume, origin: sessionOriginOfIntent(i), ...(i.budget ? { budget: i.budget } : {}) });
        ctx.recomputeWatched();
        if (steps[0]) void ctx.startPrompt(info.id, steps[0]);
        // The rest of a chain is delivered one turn at a time — `deliverPrompt`
        // waits for the session to be ready, so awaiting each is what serializes
        // them. Nothing posts a chain yet; the loop is here so that when
        // something does, the steps are not silently dropped.
        if (steps.length > 1) void ctx.deliverChain(info.id, steps.slice(1));
        return { ok: true, detail: `opened a session in ${basename(i.cwd)}`, sessionId: info.id };
      },
      sweep: (i, dirs) => ctx.fanout.sweep(i, dirs),
      async deliver(i, sessionId) {
        // A fan-out follow-up types into a session the sweep already opened, with
        // the fan-out's own retry rule and its own "never guess a completion".
        if (i.origin?.startsWith(ORIGIN_FANOUT_FOLLOWUP)) return ctx.fanout.followUpTarget(i, sessionId);
        // Everything else is a work item, and `backlog.ts` is the one place that
        // knows what each of `deliverPrompt`'s four verdicts should say.
        return ctx.backlog.deliver(i, sessionId);
      },
      async workItem(i) {
        // The schedule's "queue this in that repo" action, unchanged: it still
        // produces a Backlog row, in the Backlog sheet, with the schedule's own
        // name on it — opening the backlog at 3am, "weekly security sweep" is the
        // only thing that explains an item nobody typed. It is a row in this very
        // store now; `backlog.add` is kept as the one place that mints one.
        const inherits = workItemInherits(i);
        const text = inherits.steps[0] ?? "";
        const auto = i.auto !== false;
        // ── What the child inherits, and why it is not nothing (F14) ─────────
        //
        // WHAT travels and why is `workItemInherits`'s, next to the draft it is
        // read against — this row only MAKES the item, the child is where the
        // work happens, and a gate left behind here gates the wrong event.
        // …and WHICH rule wrote it. `lastResult.childId` only ever named the LAST
        // item a rule produced, so a nightly rule that had run four times showed
        // *backlog · 1 item* and three rows in the list said nothing about where
        // they came from. `scheduleItemOrigin` is the durable half of that link;
        // it is read back by `scheduleIdFromOrigin` and by nothing else, because
        // `schedule:` already has two reserved suffixes for the RULE's own row.
        const item = ctx.backlog.add(text, i.cwd, i.label || i.title, undefined, auto, {
          ...inherits, origin: scheduleItemOrigin(i.id),
        });
        const chain = inherits.steps.length > 1 ? `, ${inherits.steps.length} steps` : "";
        return {
          ok: true,
          childId: item.id,
          detail: `queued in ${basename(i.cwd)}${chain}${auto ? " (fires when that session is ready)" : ""} · item ${item.id}`,
        };
      },
      build: (i) => ctx.builds.execute(i),
      // A build RULE's occurrence: post one run through `run()`, stamped with
      // the rule's origin — never the rule's own row run as a build.
      scheduledBuild: (i) => ctx.builds.fireScheduled(i),
      // Checked on the PAYLOAD before the shell/build branch, in the manager: an
      // assessment is a `shell` target too, and routing on the target alone would
      // run it through the build pty.
      assess: (i) => ctx.assessExecutor(i),
      // Same exception, same reason — see `capture.ts` for what it does with the
      // time: verify → settle → diff → emit, and a verdict a person can read
      // without opening the picture.
      capture: (i) => ctx.capture.execute(i),
    },
    onChange: (intent) => {
      // Six views of one store, and every client gets whichever it speaks. Each
      // old vocabulary is a filter over the same rows — which is the whole point
      // of folding the managers in, and the reason `backlog.*`, `fanout.*` and
      // `build.*` are unchanged on the wire.
      //
      // **One row changed ⇒ send the ROW.** This used to broadcast the WHOLE
      // store first and the changed row second, on every transition — a snapshot
      // of every intent this host holds, per state change, to every connected
      // phone, over the one link this app spends its life apologising for. The
      // full list is what `hello` is for (and what a bare `onChange()` still
      // means: a row LEFT the store, or several moved at once, and neither is
      // expressible as one `intent.changed`).
      if (intent) ctx.broadcast({ t: "intent.changed", intent });
      else ctx.broadcast(ctx.intentSnapshot());
      if (!intent || intent.trigger.kind === "files") ctx.broadcast(ctx.launchSnapshot());
      // ── A row with a clock is sent to BOTH lists ─────────────────────────────
      //
      // Which list a row belongs to is DERIVED from its rule, not stored, and
      // that is the change's whole selling point: editing *once* → *every week*
      // moves the row from the backlog to Schedules with no migration. It does —
      // on the host. The phone's backlog copy is only ever replaced by a
      // `backlog.list` frame (`intent.changed` never touches it, and nothing
      // re-asks), so sending only the list the row belongs to NOW left the row it
      // just left sitting in the other sheet, with its old clock, until the
      // socket reconnected. Both directions: *weekly → once* leaves a stale card
      // in Schedules the same way.
      //
      // So any `at` row re-sends both snapshots — it MAY have just crossed, and
      // neither list can say so on its own. The cost is one small extra list per
      // transition of a clocked row; the alternative is a phantom of the very
      // edit this change exists for. (A clock being REMOVED altogether is the one
      // crossing no `at` test can see, and `update()` broadcasts the bare
      // `onChange()` for it.)
      const clocked = intent?.trigger.kind === "at";
      if (!intent || clocked || isScheduleRow(intent)) ctx.broadcast(ctx.scheduleSnapshot());
      if (!intent || clocked || isBacklogRow(intent)) ctx.broadcast(ctx.backlogSnapshot());
      if (intent && isBuildRow(intent)) ctx.broadcast({ t: "build.run", run: intentToBuildRun(intent) });
      // A capture row is neither `isBacklogRow` nor `isBuildRow`, so without this
      // it would appear in no list at all for the whole time it works — the
      // failure `assessSnapshot` exists to prevent, one row at a time.
      if (intent && isCaptureRow(intent)) ctx.broadcast({ t: "capture.run", run: intentToCaptureRun(intent) });
      if (intent && isFanoutRow(intent) && intent.groupId) {
        const run = fanoutRuns(ctx.intents.list(), Number.MAX_SAFE_INTEGER).find((r) => r.id === intent.groupId);
        if (run) ctx.broadcast({ t: "fanout.run", run });
      }
    },
    // `intents.json` stopped reaching the disk: told once per failing streak
    // (`intents/disk.ts`), never per tick. New work is refused in words at the
    // op itself; this is the sentence for whoever is not sending anything.
    onWriteError: (message) => ctx.notify("backlog", { ...intentsWriteNotice(message), level: "attention" }),
  };
}

/**
 * Sessions an automatic slot is spent on that `autoSessionCount()` cannot see yet: rows `starting`
 * whose target OPENS a session (`needsSlot`) and whose session is not live — the executor is still
 * inside `sessions.create()`, which for a plugin backend awaits `prepare()` before the session is
 * registered. Once the session is live the row names it (`noteSession`) and the host's own count
 * has it, so it is never counted twice for longer than that one step. Pure; exported for the test.
 */
export function startingSlotCount(rows: readonly Pick<Intent, "state" | "target" | "sessionId">[], isLive: (sessionId: string) => boolean): number {
  return rows.filter((r) => r.state === "starting" && needsSlot(r as Intent) && !(r.sessionId && isLive(r.sessionId))).length;
}

/** The feed row for an `intents.json` that can no longer be written. */
export function intentsWriteNotice(message: string): { title: string; body: string; tag: string } {
  return {
    title: "Scheduled work is not reaching disk",
    body: `The host could not save its backlog and schedules (${message}). New work is refused and nothing new starts ` +
      "until it can; check free disk space and that the host's state folder is writable.",
    tag: "intents-write",
  };
}
