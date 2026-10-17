/**
 * The thin host-tool sheets: each is an existing top-level sheet component
 * wired to the core. The sheets themselves (`SpeedTestSheet.tsx`,
 * `NetHealthSheet.tsx`, `ArchiveSheet.tsx`, …) are unchanged; what moved here
 * from App's `overlayViews` is only the props each was handed.
 */
import type { LaunchOpts } from "@waterplane/shared";
import { useMemo } from "react";
import { useCore, useQueueEntries, useStore } from "../../sdk";
import { ArchiveSheet } from "../../ArchiveSheet";
import { showBackendPicker } from "../../backendCaps";
import { Empty } from "../../Empty";
import { LocalRtSheet } from "../../LocalRtSheet";
import { NetHealthSheet } from "../../NetHealthSheet";
import { RepoColorSheet } from "../../RepoColorSheet";
import { SecretSheet } from "../../SecretSheet";
import { SheetHead } from "../../Sheet";
import { SpeedTestSheet } from "../../SpeedTestSheet";
import { StorageSheet } from "../../StorageSheet";
import { toolbarItems } from "../../toolbar";
import { UsageSheet } from "../../UsageSheet";
import { archiveStartRepo, knownFeatureIds, liveConversationIds } from "./logic";
import { localRtFocus, netFocus } from "./store";

export function SpeedTestToolSheet() {
  const core = useCore();
  return <SpeedTestSheet onClose={() => core.nav.close("speedtest")} />;
}

export function SecretToolSheet() {
  const core = useCore();
  return <SecretSheet repos={core.world.repos} onClose={() => core.nav.close("secret")} />;
}

export function RepoColorToolSheet() {
  const core = useCore();
  return <RepoColorSheet repos={core.world.repos} onClose={() => core.nav.close("repocolor")} />;
}

export function FeaturesToolSheet() {
  const core = useCore();
  const known = useMemo(() => knownFeatureIds(toolbarItems().map((t) => t.id)), []);
  return <UsageSheet knownIds={known} onClose={() => core.nav.close("features")} onToast={core.say.toast} />;
}

export function StorageToolSheet() {
  const core = useCore();
  return <StorageSheet onClose={() => core.nav.close("storage")} onToast={core.say.toast}
    // A count on a control is a filter: a repo row's outbox figure opens
    // exactly that repo's outbox sweep, and the × comes back here.
    onOpenSweep={(repoId, scope) => { core.say.track("overlay:sweep"); core.files.openSweep(repoId, scope, "storage"); }} />;
}

export function LocalRtToolSheet() {
  const core = useCore();
  const focus = useStore(localRtFocus);
  return <LocalRtSheet focus={focus} onClose={() => core.nav.close("localrt")}
    onOpenSession={(id) => {
      const s = core.world.sessions.find((x) => x.id === id);
      if (s) { core.nav.close("localrt"); core.nav.attach(s); } else core.say.toast("that session is no longer open");
    }} />;
}

export function NetHealthToolSheet() {
  const core = useCore();
  const focus = useStore(netFocus);
  const entries = useQueueEntries();
  return <NetHealthSheet onClose={() => core.nav.close("nethealth")} onToast={core.say.toast} focus={focus}
    notDelivered={entries.filter((e) => e.status === "failed").length}
    onOpenStorage={() => { core.say.track("overlay:storage"); core.nav.open("storage"); }}
    // The list this sheet used to draw is Activity's now — one row per send
    // for its whole life, un-clipped, with the repo it was written for.
    // It counts the undelivered ones two lines up, so it opens on those and
    // not on the whole list — same rule as the queue bar's Manage.
    onOpenActivity={() => {
      core.say.track("action:queue.manage");
      const stuck = entries.filter((e) => e.status === "failed");
      core.nav.openActivity(stuck.length ? { entries: stuck, label: "the messages that were not delivered" } : undefined);
    }} />;
}

export function ArchiveToolSheet() {
  const core = useCore();
  const { sessions, activeRepo, visibleRepos, backends, launch } = core.world;
  const liveIds = useMemo(() => liveConversationIds(sessions), [sessions]);
  // Repo-scoped, because a conversation log lives under its directory. Opens
  // on the repo in context; the picker inside covers the rest.
  const start = archiveStartRepo(activeRepo?.id ?? null, visibleRepos.map((r) => r.id));
  const close = () => core.nav.close("archive");
  if (!start) return (
    <div className="sheet">
      <SheetHead title={"Archive"} onClose={close} />
      <Empty>No repo in context — open a session first.</Empty>
    </div>
  );
  // Every row here is a CLAUDE conversation log — that is what the archive
  // reads off disk. So both verbs launch claude explicitly, whatever the
  // launcher's current default backend is: resuming a claude conversation
  // under another binary is not a resume, it is a new session with someone
  // else's id on the command line. `backendMark` decides whether the sheet
  // bothers to say so, which it only does where a second backend exists.
  const claudeLaunch: LaunchOpts = core.launch.wire({ ...launch, backend: undefined });
  return <ArchiveSheet repos={visibleRepos} initialRepoId={start}
    liveIds={liveIds}
    backendNote={showBackendPicker(backends)
      ? "Every conversation here is one Claude Code wrote, so resuming or forking one starts Claude Code — not whichever backend new sessions currently default to."
      : undefined}
    onResume={(cwd, title, cid) => { close(); core.launch.openCwd(cwd, title, true, "continue", claudeLaunch, cid); }}
    // The same durable create, one flag different: `--resume <id>
    // --fork-session` mints a new conversation and leaves the original file
    // untouched, so this is additive — nothing in the archive changes.
    onFork={(cwd, title, cid) => { close(); core.launch.openCwd(cwd, title, true, "fork", claudeLaunch, cid); }}
    onOpenLive={(cid) => { const s = sessions.find((x) => x.claudeSessionId === cid); if (s) core.nav.attach(s); }}
    showToast={core.say.toast}
    onClose={close} />;
}
