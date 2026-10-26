/**
 * The `build` overlay: `BuildSheet.tsx` wired to this feature's stores and
 * actions. The sheet itself stays a flat module (its props are its contract);
 * this is the prop list `App.tsx`'s `overlayViews.build` used to spell out.
 */
import { useEffect, useMemo } from "react";
import type { BuildArtifact, RepoTarget } from "@waterplane/shared";
import { useCore, useStore } from "../../sdk";
import { BuildSheet } from "../../BuildSheet";
import { buildLogSeed } from "../../buildLogPrompt";
import { artifactPolicies, buildCands, buildLocalIds, buildOpts, buildRunFocus, buildScheduleEdit, builds } from "./store";
import { buildScheduleCue } from "../../buildSchedule";
import { askOptions, cancelBuild, openBuildScheduleCut, runBuild, saveBuildSchedule, saveBuilds, savePolicy, scanRepo, setupBuilds } from "./actions";

export function BuildButtonsSheet({ repo: opened }: { repo: RepoTarget }) {
  const core = useCore();
  // `opened` is the snapshot taken at the tap; the failure the sheet shows is the LIVE listing's.
  const repo = core.world.repos.find((r) => r.id === opened.id) ?? opened;
  const dir = repo.worktreePath;
  const cfgs = useStore(builds.cfgs);
  const allRuns = useStore(builds.runs);
  const outTick = useStore(builds.outTick);
  const cands = useStore(buildCands).get(dir);
  const opts = useStore(buildOpts).get(dir);
  const localIds = useStore(buildLocalIds).get(dir);
  const policy = useStore(artifactPolicies).get(dir);
  const runs = useMemo(() => allRuns.filter((r) => r.repoDir === dir), [allRuns, dir]);
  const list = cfgs.lists.get(dir) ?? [];
  const listAt = cfgs.at.get(dir) ?? 0;
  // A build rule's card *edit*: handed to the sheet once its entry is in the
  // list; a list that has ARRIVED without it means the build is gone — said.
  const handOver = useStore(buildScheduleEdit);
  const pendingEdit = handOver?.entry ?? null;
  const editBuild = pendingEdit?.action.kind === "build" ? list.find((b) => b.id === (pendingEdit.action as { buildId: string }).buildId) : undefined;
  const scheduleEdit = useMemo(() => (pendingEdit && editBuild ? { build: editBuild, entry: pendingEdit } : null), [pendingEdit, editBuild]);
  useEffect(() => {
    if (!pendingEdit || !handOver) return;
    if (scheduleEdit) { buildScheduleEdit.set(null); return; }
    // Only a list read after the tap may say the build is gone; the device
    // cache seeds `listAt` with an older one.
    if (listAt > handOver.at && pendingEdit.action.kind === "build") {
      core.say.toast(`build ${pendingEdit.action.buildId} is no longer in this repo — the rule cannot be edited here`);
      buildScheduleEdit.set(null);
    }
  }, [handOver, pendingEdit, scheduleEdit, listAt, core]);
  // A rule card's *last run*: the sheet opens that run (its own effect runs
  // first, child before parent), then the hand-over is spent.
  const focusRun = useStore(buildRunFocus);
  useEffect(() => { if (focusRun) buildRunFocus.set(null); }, [focusRun]);
  const schedules = core.world.schedules;
  return (
    <BuildSheet
      repo={repo}
      failed={repo.buildFailed}
      onDone={(id) => core.conn.liveSend({ t: "notification.handle", id }, "marked done")}
      builds={list}
      listAt={listAt}
      runs={runs}
      // The buffer itself (read-only, moved in place); `outTick` says when to look again.
      output={builds.output}
      outTick={outTick}
      online={core.conn.status === "open"}
      localIds={localIds}
      onSave={(b, local) => saveBuilds(dir, b, local)}
      onRun={(id, params) => runBuild(dir, id, params)}
      onCancel={cancelBuild}
      onDownload={(a: BuildArtifact) => core.files.downloadArtifact(a)}
      onSetup={(prompt) => setupBuilds(repo, prompt)}
      onSendLog={(r, log, took) => core.nav.openSend(buildLogSeed(r, log, repo, took))}
      candidates={cands?.list ?? null}
      candidatesTotal={cands?.total ?? 0}
      paramOptions={opts}
      policy={policy}
      onSavePolicy={(p) => savePolicy(dir, p)}
      onAskOptions={(buildId, approve) => askOptions(dir, buildId, approve)}
      onScan={() => scanRepo(dir)}
      onClose={() => core.nav.close("build")}
      // A clock: the cue off the phone's rule list, its cut, and the form's save.
      scheduleCue={(b) => buildScheduleCue(schedules, dir, b, Date.now())}
      onOpenScheduleCut={openBuildScheduleCut}
      onSaveSchedule={(b, entry, when, vals, preview) => saveBuildSchedule(dir, b, entry, when, vals, preview)}
      usage={core.world.usage}
      scheduleEdit={scheduleEdit}
      focusRun={focusRun}
    />
  );
}
