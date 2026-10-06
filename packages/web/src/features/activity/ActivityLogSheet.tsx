/**
 * The `activity` overlay: `ActivitySheet.tsx` — every posted piece of work,
 * one row for its whole life — wired to this feature's stores and the core.
 * Row building is `activityRows.ts` (pure, node-tested); this is only the
 * state it reads and the things it can do.
 */
import { useMemo } from "react";
import { ActivitySheet } from "../../ActivitySheet";
import { baseName } from "../../format";
import { syncSnapshot } from "../../link";
import { useCore, useQueueEntries, useStore } from "../../sdk";
import { confirmedDone, filed, focus, pullList } from "./store";
import { act, bulk, closeActivity, retarget } from "./actions";

export function ActivityLogSheet() {
  const core = useCore();
  const { sessions, visibleRepos, intents, backlog } = core.world;
  const outbox = useQueueEntries();
  const pulls = useStore(pullList);
  const dismissed = useStore(filed);
  const done = useStore(confirmedDone);
  const f = useStore(focus);
  // The check verdicts, keyed by id — a sidecar here as it is on the host,
  // because a review verdict is not lifecycle.
  const reviews = useMemo(() => Object.fromEntries(backlog.map((b) => [b.id, b])), [backlog]);
  return <ActivitySheet
    outbox={outbox}
    // The FLUSHER's verdict, not a second reading of the same facts.
    queueBlocked={core.queue.blocked}
    goneLanes={core.queue.goneLanes()}
    intents={intents}
    reviews={reviews}
    pulls={pulls}
    sessions={sessions}
    repos={visibleRepos}
    online={core.conn.status === "open"}
    hostSeenAt={syncSnapshot().lastSeenAt}
    laneLabel={core.queue.laneLabel}
    repoName={(cwd) => core.world.repoForCwd(cwd)?.repoName ?? baseName(cwd)}
    // What lets a row's `AttachStrip` ask the host about the files its words
    // name. The same one mapping `PadSheet` is handed, not a second one.
    repoIdForCwd={(cwd) => core.world.repoForCwd(cwd)?.id ?? null}
    onAction={act}
    onRetarget={retarget}
    dismissed={dismissed}
    confirmedDone={done}
    onBulk={bulk}
    // Which rows the caller pointed this screen at — the queue bar's Manage,
    // or one of the names under it. Read once by the sheet, which then owns
    // dropping it.
    focus={f}
    onOpenSession={(sid) => { const s = sessions.find((x) => x.id === sid); if (s) core.nav.attach(s); else core.say.toast("that session is no longer open"); }}
    onClose={closeActivity}
  />;
}
