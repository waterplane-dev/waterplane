/**
 * The pending screen's own rows (`PendingWords.tsx`), wired to the core and to
 * this feature's verbs — the ones Waiting work's rows use.
 */
import { repoShown } from "@waterplane/shared";
import { PendingWords } from "../../PendingWords";
import { baseName } from "../../format";
import { syncSnapshot } from "../../link";
import { useCore, useQueueEntries } from "../../sdk";
import { useNow } from "../../useNow";
import { act, retarget } from "./actions";

export function PendingPrompts({ createAck }: { createAck: string }) {
  const core = useCore();
  const outbox = useQueueEntries();
  const now = useNow(10_000);
  const { sessions, visibleRepos } = core.world;
  return <PendingWords createAck={createAck} outbox={outbox} now={now}
    online={core.conn.status === "open"} hostSeenAt={syncSnapshot().lastSeenAt}
    laneLabel={core.queue.laneLabel}
    repoName={(cwd) => { const r = core.world.repoForCwd(cwd); return r ? repoShown(r) : baseName(cwd); }}
    queueBlocked={core.queue.blocked} goneLanes={core.queue.goneLanes()}
    sessions={sessions} repos={visibleRepos}
    repoIdForCwd={(cwd) => core.world.repoForCwd(cwd)?.id ?? null}
    onAction={act} onRetarget={retarget}
    onOpenSession={(sid) => { const s = sessions.find((x) => x.id === sid); if (s) core.nav.attach(s); else core.say.toast("that session is no longer open"); }} />;
}
