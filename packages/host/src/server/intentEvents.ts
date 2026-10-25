/**
 * The intent store as the phone sees it: the snapshots (schedule, launch,
 * intent, assess, backlog), the pad notes an assessment reads, and the four
 * `intents.on(…)` blocks that turn a transition into a notification.
 *
 * Moved verbatim out of `main.ts` (M4 of the host split, see
 * docs/notes/host-architecture.md). Every manager is read as `ctx.<x>` at CALL
 * time: the snapshots are handed to constructions that run long before
 * `backlog`/`naming` exist in boot order, and are only invoked
 * later.
 *
 * `createSnapshots(ctx)` registers nothing and reads nothing at creation, so
 * `main.ts` may call it anywhere before the first snapshot is INVOKED.
 * `wireIntentEvents(ctx)` registers `settled`, `requeued`, `skipped`,
 * `missed`, in that order, and is called at the position the first
 * `intents.on` held in `main.ts` — after `new IntentManager`, before
 * `intents.migrateLegacy(…)` / `intents.start()`, which stay in `main.ts`.
 */
import { basename } from "node:path";
import type { AssessNote, HostMessage, Intent, IntentResult, ScheduleEntry } from "@waterplane/shared";
import { CLOSE_WHEN_DONE_KEY, closeWhenDoneSetting, logTag, lsKey } from "@waterplane/shared";
import {
  describeSchedule,
  intentToBuildRun,
  intentToLaunch,
  intentToSchedule,
  isBacklogRow,
  isBuildRow,
  isLaunchRow,
  isScheduleRow,
} from "../intents/adapters.js";
import type { ServerCtx } from "./ctx.js";

/** Everything `createSnapshots` built; `main.ts` assigns each into `ctx`. */
export type Snapshots = ReturnType<typeof createSnapshots>;

export function createSnapshots(ctx: ServerCtx) {
  /** The schedule list as clients see it — a VIEW of the intent store now.
   *  `running` is transient host state (an action in flight) and is derived at
   *  send time, exactly as it was when it was never persisted. */
  function scheduleSnapshot(): HostMessage {
    return { t: "schedule.list", entries: ctx.intents.list().map(intentToSchedule).filter((e): e is ScheduleEntry => !!e) };
  }

  /** The launches this host is holding or has settled — the same view, filtered
   *  by the only thing that ever distinguished one: a `files` trigger. */
  function launchSnapshot(): HostMessage {
    return { t: "launch.list", launches: ctx.intents.list().filter(isLaunchRow).map(intentToLaunch) };
  }

  function intentSnapshot(): HostMessage {
    return { t: "intent.list", intents: ctx.intents.list() };
  }

  /** One repo's newest assessment run. `null` is a fact ("never assessed here"),
   *  which is a different sentence from "we could not ask". */
  function assessSnapshot(repoDir: string): HostMessage {
    return { t: "assess.state", repoDir, run: ctx.assess.latestFor(repoDir) ?? null };
  }

  /**
   * The pad notes carrying one `cwd` — the other half of "everything left".
   *
   * The pad is a SYNCED SETTING, and `settings.ts` is deliberately blind: it
   * stores the client's raw localStorage string, never parses it, and has no
   * opinion about its shape, which is what lets the phone change these shapes
   * without the daemon being upgraded in lockstep. This is the one place that
   * looks inside one, and it is READ-ONLY on purpose. `shared/pad.ts` MERGES the
   * two copies per note now, tombstones and all, so nothing is lost when two
   * devices write — but that merge is the CLIENT's, run on adopt, and it is the
   * merge that makes a write safe. A daemon writing this value back would be
   * doing the thing the merge replaced: last-write-wins on the whole string, with
   * no diff and nothing on the wire to distinguish it from a deliberate delete,
   * on the store whose whole job is to be the last copy of words that never ran.
   *
   * So it is defensive rather than authoritative: an unparseable value, a value
   * that is not an array, a note with no text — all of them mean "no notes",
   * never a thrown assessment.
   */
  function padNotesFor(cwd: string): AssessNote[] {
    const raw = ctx.settings.get(lsKey("pad"))?.value;
    if (typeof raw !== "string" || !raw) return [];
    try {
      const list = JSON.parse(raw) as unknown;
      if (!Array.isArray(list)) return [];
      const out: AssessNote[] = [];
      for (const n of list) {
        if (!n || typeof n !== "object") continue;
        const d = n as { id?: unknown; text?: unknown; ts?: unknown; cwd?: unknown };
        if (typeof d.id !== "string" || !d.id) continue;
        if (typeof d.text !== "string" || !d.text.trim()) continue;
        // A note is target-less by design; only one that NAMES this worktree is
        // part of this repo's "everything left".
        if (d.cwd !== cwd) continue;
        out.push({ id: d.id, text: d.text, createdAt: typeof d.ts === "number" ? d.ts : undefined });
      }
      return out;
    } catch { return []; }
  }

  function backlogSnapshot(): HostMessage {
    return {
      t: "backlog.list",
      items: ctx.backlog.list(),
      auto: ctx.backlog.getAuto(),
      idleMs: ctx.backlog.idleMs,
      waiting: ctx.backlog.waiting(),
      // The cap as facts — the ceiling and every open automatic session with
      // whether it closes itself — so a row held on `noSlot` can offer "close
      // one to make room" as a person's tap. Never an action.
      autoSlots: ctx.backlog.autoSlotFacts(),
      // The rows a naming pass is titling RIGHT NOW. Transient like `waiting`:
      // memory only, gone with a restart, and absent (rather than `[]`) on a host
      // where nothing is running, so a client can tell "no pass" from "a pass
      // that has finished its last row".
      naming: ctx.naming.runningIds().length ? ctx.naming.runningIds() : undefined,
    };
  }

  return { scheduleSnapshot, launchSnapshot, intentSnapshot, assessSnapshot, padNotesFor, backlogSnapshot };
}

export function wireIntentEvents(ctx: ServerCtx): void {
  // The global *close automatic sessions when done* — a synced setting the
  // phone writes (`CLOSE_WHEN_DONE_KEY`) and the backlog reads at CALL time, so
  // the next sweep obeys the last tap. `ctx.settings` is assigned later in
  // boot; until then, and for anything but "1", the answer is OFF — nothing
  // closes an automatic session unless the person (or its item) asked.
  ctx.backlog.setCloseWhenDoneDefault(() => closeWhenDoneSetting(ctx.settings?.get(CLOSE_WHEN_DONE_KEY)?.value));
  ctx.intents.on("settled", (i: Intent, res: IntentResult) => {
    if (i.trigger.kind === "files") {
      if (res.ok && i.sessionId) {
        // The prompts the phone queued BEHIND this create have been unaddressable
        // until now — the ack that accepted it could not name a session, because
        // none existed. This is the message that binds them.
        ctx.broadcast({ t: "launch.opened", id: i.id, sessionId: i.sessionId, cwd: i.cwd });
        if (i.missing?.length) {
          // It went without files. Say so loudly: the prompt inside that session
          // still tells the agent to look at a path that is not there.
          ctx.notify("info", {
            title: `Session opened · ${basename(i.cwd)}`,
            body: `opened without ${i.missing.length === 1 ? basename(i.missing[0]) : `${i.missing.length} files`}`,
            sessionId: i.sessionId, tag: `launch-${i.id}`,
          });
        }
        return;
      }
      if (i.state === "failed") {
        console.log(`${logTag} launch FAILED · ${basename(i.cwd)}: ${res.detail}`);
        ctx.notify("info", {
          title: `Session never opened · ${basename(i.cwd)}`,
          body: `${res.detail}. The words are still here — the row keeps them.`,
          tag: `launch-${i.id}`,
        });
      }
      return;
    }
    // `isScheduleRow`, not `trigger.kind === "at"` — the same correction
    // `onChange`'s broadcast above took, and for the same reason. A one-off aimed
    // at one repo is a BACKLOG row that happens to carry a clock, so it settled
    // under the schedule sentence ("Scheduled: …" / "Schedule failed: …"), which
    // is governed by the **`info`** notification preference and has no
    // tap-through to the row. Its outcome is now announced under **`backlog`**
    // like every other work item: the preference a person who turned the backlog
    // on is expecting to govern it, and a body that names the item's own words
    // with its `sessionId` attached, so the notification opens the conversation
    // that ran it. A standing rule and a one-off SWEEP keep the schedule wording,
    // which is the only thing either of them is.
    if (isScheduleRow(i)) {
      const late = res.late ? " (late — the host was asleep at the scheduled time)" : "";
      console.log(`${logTag} schedule ${res.ok ? "fired" : "FAILED"} · ${describeSchedule(i)}${late}: ${res.detail}`);
      ctx.notify("info", {
        title: `${res.ok ? "Scheduled" : "Schedule failed"}: ${i.title || i.id}`,
        body: `${res.detail}${late}`,
        tag: `schedule-${i.id}`, outcome: res.ok ? "ok" : "failed",
        ...(res.ok ? {} : { key: `schedule:${i.id}` }),
      });
      if (res.ok) {
        const at = new Date();
        ctx.resolveAttention(`schedule:${i.id}`, `fixed by the ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")} run`);
      }
      return;
    }
    if (isBuildRow(i)) { ctx.announceBuild(intentToBuildRun(i)); return; }
    // A work item, in the words the backlog has always used for these. Only a
    // TERMINAL row is announced: a `retry` requeue records its verdict too, and
    // pushing "not delivered" for something about to be delivered is exactly the
    // false alarm this rework exists to stop.
    if (!isBacklogRow(i)) return;
    if (i.state === "done") {
      ctx.notify("backlog", { title: "Backlog item done", body: i.label || textOf(i), sessionId: i.sessionId, tag: "backlog", outcome: "ok" });
      return;
    }
    if (i.state === "failed") {
      ctx.notify("backlog", { title: "Backlog item not delivered", body: i.label || textOf(i), sessionId: i.sessionId, tag: "backlog", outcome: "failed" });
    }
  });

  /**
   * Work put back in the queue rather than failed.
   *
   * The only route to this is a session that exited at the USAGE LIMIT: the host
   * reopens it at the reset, so the item follows rather than dying. Announced
   * because the pause is the interesting part — "nothing is happening" with no
   * reason is what the whole `waiting()` ladder exists to prevent.
   */
  ctx.intents.on("requeued", (i: Intent) => {
    if (!isBacklogRow(i)) return;
    ctx.notify("backlog", { title: "Backlog paused · usage limit", body: i.label || textOf(i), tag: "backlog", level: "info" });
  });

  /** One row's words, for a notification body. */
  const textOf = (i: Intent): string => (i.payload.kind === "prompt" ? i.payload.steps[0] : i.title || i.id);

  /**
   * A scheduled occurrence that blew past its grace window.
   *
   * `schedule.ts` recorded this onto a row it then DELETED (a spent `once` was
   * removed from the list, prompt text and all) and told nobody at all — so an
   * occurrence that never ran was indistinguishable from one that had. The row
   * survives now, and this is the sentence that says which it was.
   */
  /**
   * A `window` occurrence that did not run because its condition was not met.
   *
   * Its own event and its own sentence, deliberately kept apart from `missed`:
   * "the host was asleep past the grace" and "the rule you wrote said not to"
   * are different facts, and only the second is something the person DECIDED.
   * Reporting a deliberate skip as a miss would teach people to ignore the one
   * notification that tells them their condition is doing its job — or worse, to
   * go looking for a host that was never down.
   */
  ctx.intents.on("skipped", (i: Intent, res: IntentResult) => {
    console.log(`${logTag} schedule SKIPPED · ${describeSchedule(i)}: ${res.detail}`);
    ctx.notify("info", {
      title: `Skipped: ${i.title || i.label || i.id}`,
      body: `${res.detail}. Nothing ran; the next occurrence is armed.`,
      tag: `schedule-${i.id}`,
    });
  });

  ctx.intents.on("missed", (i: Intent, res: IntentResult) => {
    console.log(`${logTag} schedule MISSED · ${describeSchedule(i)}: ${res.detail}`);
    ctx.notify("info", {
      title: `Schedule missed: ${i.title || i.id}`,
      body: `${res.detail}. It did not run; the next occurrence is armed.`,
      tag: `schedule-${i.id}`,
    });
  });
}
