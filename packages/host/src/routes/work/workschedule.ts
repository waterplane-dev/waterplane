/**
 * Work routes — schedule slice of `routes/work.ts` (see that file for the whole picture).
 */
import { scheduleToIntent } from "../../intents/adapters.js";
import { fmtOffset } from "@waterplane/shared";
import type { Route, RouteSpec, RouteTable } from "../types.js";

/**
 * ── The launch and schedule messages, spoken by the intent store ───────────
 *
 * `LaunchManager` and `ScheduleManager` are gone; `intents/adapters.ts` renders
 * the same two DTOs out of the one store. Every handler below is therefore an
 * adapter, kept rather than retired because the APK shell can pin an old bundle
 * for weeks and because the e2e scripts that pin these behaviours are the
 * evidence that folding the two managers together changed nothing a user sees.
 */
const onLaunchList: Route<"launch.list"> = (a) => {
    a.c.send(a.ws, a.c.launchSnapshot());
};

const onLaunchCancel: Route<"launch.cancel"> = (a) => {
    // Not durable, like every other destructive command here: a cancel
    // delivered an hour late would call off a session that has since opened
    // and been worked in.
    if (!a.c.intents.cancel(a.msg.id)) a.c.send(a.ws, { t: "toast", text: "that launch has already been settled" });
    a.c.broadcast(a.c.launchSnapshot());
};

const onLaunchRun: Route<"launch.run"> = (a) => {
    // "The picture is not coming — run it anyway." The row keeps naming the
    // files it went without, because the prompt in that session still refers
    // to them.
    void a.c.intents.runNow(a.msg.id).then((r) => {
      if (!r.ok) a.c.send(a.ws, { t: "toast", text: `launch: ${r.reason}` });
      a.c.broadcast(a.c.launchSnapshot());
    });
};

const onScheduleList: Route<"schedule.list"> = (a) => {
    a.c.send(a.ws, a.c.scheduleSnapshot());
};

const onScheduleSave: Route<"schedule.save"> = (a) => {
    // Upsert by the client-minted id, which is what makes a re-send of the
    // same edit safe: a second copy of "every Thursday" would fire the sweep
    // twice, so the id has to be the identity. The ackId is on top of that,
    // for the phone's send queue — a schedule written offline is queued like a
    // prompt, and a replay lands on the same row.
    const entry = a.msg.entry;
    a.c.durableOp(a.ws, a.msg.ackId, () => {
      const draft = scheduleToIntent(entry, Date.now());
      const saved = draft ? a.c.intents.upsert(draft) : null;
      a.c.broadcast(a.c.scheduleSnapshot());
      const ro = a.c.intents.readOnly();
      if (!saved && ro) {
        a.c.send(a.ws, { t: "toast", text: `schedule: not saved — ${ro}` });
        return { ok: false, reason: ro };
      }
      if (!saved) {
        a.c.send(a.ws, { t: "toast", text: "schedule: nothing to run (pick repos and write a prompt)" });
        return { ok: false, reason: "nothing to run" };
      }
      // RELATIVE, never a wall clock: this string is formatted on the desktop
      // and read on a phone, and `toLocaleString()` answers in the desktop's
      // locale — the same instant then appears twice on one screen in two
      // notations (the schedule row prints `nextAt` in the reader's own). A
      // duration reads the same everywhere, and the list the broadcast below
      // refreshes carries the instant itself.
      a.c.send(a.ws, { t: "toast", text: `saved · ${saved.nextAt ? `next run in ${fmtOffset(Math.max(0, Math.round((saved.nextAt - Date.now()) / 60_000)))}` : "nothing armed (disabled)"}` });
      return { ok: true, intentId: saved.id };
    }, a.msg);
};

const onScheduleRemove: Route<"schedule.remove"> = (a) => {
    // An explicit delete, which is the one way a row leaves this store other
    // than compaction — and it is archived on the way out, because the words
    // were still the user's.
    a.c.intents.remove(a.msg.id);
    a.c.broadcast(a.c.scheduleSnapshot());
};

const onScheduleSetEnabled: Route<"schedule.setEnabled"> = (a) => {
    a.c.intents.setArmed(a.msg.id, a.msg.enabled);
    a.c.broadcast(a.c.scheduleSnapshot());
};

/** Sit out the next occurrence. Not durable and never queued offline, for
 *  `intent.cancel`'s reason: a skip delivered an hour late would spend an
 *  occurrence that has already run. */
const onScheduleSkipNext: Route<"schedule.skipNext"> = (a) => {
    const r = a.c.intents.skipNext(a.msg.id);
    a.c.send(a.ws, {
      t: "toast",
      // Same rule as the save toast above: a duration, not this desktop's date.
      text: r.ok
        ? `skipped · ${r.nextAt ? `next run in ${fmtOffset(Math.max(0, Math.round((r.nextAt - Date.now()) / 60_000)))}` : "nothing armed after it"}`
        : `schedule: ${r.reason}`,
    });
    a.c.broadcast(a.c.scheduleSnapshot());
};

/**
 * A manual fire is a real sweep — durable for the same reason `fanout.run` is:
 * a phone that never saw the receipt must not spawn it a second time. It does
 * NOT consume the next scheduled occurrence (see `IntentManager.runNow`).
 */
const onScheduleRun: RouteSpec<"schedule.run"> = {
  durable: true,
  run: (a) => a.c.intents.runNow(a.msg.id).then((r) => {
    if (!r.ok) a.c.send(a.ws, { t: "toast", text: `schedule: ${r.reason}` });
    a.c.broadcast(a.c.scheduleSnapshot());
    return { ok: r.ok, reason: r.reason };
  }),
};

// ── The durable Intent ──────────────────────────────────────────────────────

export const workscheduleRoutes: RouteTable = {
  "launch.list": onLaunchList,
  "launch.cancel": onLaunchCancel,
  "launch.run": onLaunchRun,
  "schedule.list": onScheduleList,
  "schedule.save": onScheduleSave,
  "schedule.remove": onScheduleRemove,
  "schedule.setEnabled": onScheduleSetEnabled,
  "schedule.run": onScheduleRun,
  "schedule.skipNext": onScheduleSkipNext,
};
