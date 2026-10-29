/**
 * The `queue` overlay: `QueueSheet.tsx` — the phone's send queue, plus the
 * launches the desktop is holding — wired to the core's queue verbs. Nothing
 * here is a second send path: every verb IS the queue core's function.
 */
import type { OutboxEntry } from "../../outbox";
import { QueueSheet } from "../../QueueSheet";
import { useCore, useQueueEntries } from "../../sdk";
import { LAUNCH_HELD_OFFLINE } from "./logic";
import { resend, sendAll, toggleSerialAll } from "./actions";

export function SendQueueSheet() {
  const core = useCore();
  const { liveSend } = core.conn;
  const v = core.queue.verbs;
  const entries = useQueueEntries();
  return <QueueSheet
    entries={entries as OutboxEntry[]} laneLabel={core.queue.laneLabel} online={core.conn.status === "open"}
    sessions={core.world.sessions} repos={core.world.visibleRepos}
    goneLanes={core.queue.goneLanes()}
    launches={core.world.launches}
    // Both were bare socket writes. These rows have LEFT this phone — the
    // desktop is holding them — so the only two decisions offered here are
    // ones only a person can make, and a tap that quietly did nothing was the
    // worst possible place for it.
    onCancelLaunch={(id) => liveSend({ t: "launch.cancel", id }, "called off — that session will not open", LAUNCH_HELD_OFFLINE)}
    onRunLaunch={(id) => liveSend({ t: "launch.run", id }, "opening it now, without the files it was waiting for", LAUNCH_HELD_OFFLINE)}
    onEdit={v.editQueued} onRemove={v.removeQueued} onMove={v.moveQueued}
    // Moved onto a backlog: show it there, newest on top.
    onRetarget={(ackId, to) => { if (v.retargetQueued(ackId, to) && to.mode === "backlog") core.nav.openBacklogCut(to.cwd); }} onToggleHold={v.toggleHoldQueued}
    onToggleSerial={v.toggleSerialQueued}
    serialSessions={core.queue.serial.on}
    onToggleSerialAll={toggleSerialAll}
    onSendNow={v.sendQueuedNow} onRetryFailed={v.retryFailedQueued} onSendAll={sendAll}
    onRestore={v.restoreQueued} onAddPrompt={v.addPromptToQueuedCreate} onClose={() => core.nav.close("queue")}
    repoIdOf={core.queue.repoIdOf}
    onResend={resend}
  />;
}
