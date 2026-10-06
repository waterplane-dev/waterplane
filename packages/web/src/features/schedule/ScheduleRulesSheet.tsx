/**
 * The `schedule` overlay: `ScheduleSheet.tsx` wired to this feature's stores
 * and the core — the prop list `App.tsx`'s `overlayViews.schedule` spelled out.
 */
import { useMemo } from "react";
import { onceIn } from "../../sendIntent";
import { intentRowKey } from "../../activityRows";
import { useCore, useQueueEntries, useStore } from "../../sdk";
import { ScheduleSheet } from "../../ScheduleSheet";
import { pendingSchedulesOf, spentLabel } from "./logic";
import { scheduleFocus, scheduleFocusIds, schedules, schedulesAt as schedulesAtStore } from "./store";
import { clearScheduleFocus, removeSchedule, runScheduleNow } from "./actions";

export function ScheduleRulesSheet() {
  const core = useCore();
  const { liveSend } = core.conn;
  const { sessions, visibleRepos, active, intents } = core.world;
  const entries = useStore(schedules);
  const schedulesAt = useStore(schedulesAtStore);
  const focus = useStore(scheduleFocus);
  const focusIds = useStore(scheduleFocusIds);
  const outbox = useQueueEntries();
  // The saves still in the send queue. Arming one offline always worked —
  // `schedule.save` is a durable op — but the LIST is host state, so the row
  // appeared nowhere until the link came back and the sheet said nothing was
  // scheduled at the one moment you had just scheduled something. The op
  // carries the whole entry, so the row can be drawn from the queue itself; it
  // upserts on the id, which is what lets the sheet show one row per schedule
  // rather than a queued copy beside the armed one it edits.
  const pendingSchedules = useMemo(() => pendingSchedulesOf(outbox), [outbox]);
  return <ScheduleSheet
    repos={visibleRepos}
    entries={entries}
    pending={pendingSchedules}
    listAt={schedulesAt}
    focus={focus}
    // The link in from a backlog row — "from the schedule “x”" opens that
    // one rule. Cleared by the same button as the horizon filter, because
    // from the reader's side they are one thing: a short list, said.
    focusIds={focusIds}
    onClearFocus={clearScheduleFocus}
    // Where the one-offs that have already run went. They are Activity's
    // rows now (one row for a thing's whole life), so the hand-off is the
    // same focus the queue bar's Manage uses: these ids, named, with the
    // way back to everything else one tap away.
    onOpenSpent={(ids) => core.nav.openActivity({ keys: ids.map(intentRowKey), label: spentLabel(ids.length) })}
    online={core.conn.status === "open"}
    usage={core.world.usage}
    // The way back to the CLI, in two hops the sheet walks itself: a
    // `backlog` schedule's fire CREATES a work item (`lastResult.childId`)
    // and that item names the session it was typed into.
    intents={intents}
    sessions={sessions}
    // Sit out one occurrence. Deliberately NOT durable and never queued
    // offline, for `intent.cancel`'s reason: a skip delivered an hour late
    // spends an occurrence that has already run.
    onSkipNext={(id) => { liveSend({ t: "schedule.skipNext", id }, "skipping the next run…", "no connection — a skip has to reach the desktop before the run does"); }}
    onOpenSession={(sid) => { const s = sessions.find((x) => x.id === sid); if (s) { core.nav.close("schedule"); core.nav.attach(s); } else core.say.toast("that session is no longer open"); }}
    // Where a rule's work lands: the door to the backlog rows it wrote,
    // filtered to the one it wrote when the phone knows which.
    onOpenBacklog={(repoDir, ids, label) => core.nav.openBacklogCut(repoDir, ids, label)}
    renderRetime={core.send.renderRetime}
    // Writing one is the Send sheet: a schedule is a send whose WHEN is a
    // wall-clock rule, and `schedule.save` is what `dispatchIntent` posts
    // for it — upserted on the id, so an offline replay overwrites rather
    // than adding a second copy of the same weekly sweep.
    onEdit={(e) => core.nav.openSend(e ? core.send.seedFromSchedule(e) : {
      when: onceIn(3600e3),
      target: { kind: "repo", cwd: active?.cwd ?? visibleRepos.find((r) => r.isPrimary)?.worktreePath ?? "" },
      cwdHint: active?.cwd ?? null,
      origin: "New schedule",
    })}
    onRunNow={runScheduleNow}
    // Live-only, like the limit sheet's controls and the backlog mutations:
    // "switch it off" and "delete it" are decisions about a run that may be
    // minutes away, and one delivered an hour late is about a situation that
    // has already resolved itself. The guard is here too, where the write is,
    // because a tunnel dies under a socket that still reads open.
    onSetEnabled={(id, enabled) => liveSend({ t: "schedule.setEnabled", id, enabled }, enabled ? "armed" : "switched off",
      "no connection — this one is armed on the desktop and can only be changed there")}
    onRemove={removeSchedule}
    onClose={() => core.nav.close("schedule")}
  />;
}
