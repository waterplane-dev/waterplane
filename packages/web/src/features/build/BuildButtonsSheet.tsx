/**
 * The `build` overlay: `BuildSheet.tsx` wired to this feature's stores and
 * actions. The sheet itself stays a flat module (its props are its contract);
 * this is the prop list `App.tsx`'s `overlayViews.build` used to spell out.
 */
import { useMemo } from "react";
import type { BuildArtifact, RepoTarget } from "@waterplane/shared";
import { useCore, useStore } from "../../sdk";
import { BuildSheet } from "../../BuildSheet";
import { artifactPolicies, buildCands, buildOpts, builds } from "./store";
import { askOptions, cancelBuild, runBuild, saveBuilds, savePolicy, scanRepo, setupBuilds } from "./actions";

export function BuildButtonsSheet({ repo }: { repo: RepoTarget }) {
  const core = useCore();
  const dir = repo.worktreePath;
  const cfgs = useStore(builds.cfgs);
  const allRuns = useStore(builds.runs);
  const outTick = useStore(builds.outTick);
  const cands = useStore(buildCands).get(dir);
  const opts = useStore(buildOpts).get(dir);
  const policy = useStore(artifactPolicies).get(dir);
  const runs = useMemo(() => allRuns.filter((r) => r.repoDir === dir), [allRuns, dir]);
  return (
    <BuildSheet
      repo={repo}
      builds={cfgs.lists.get(dir) ?? []}
      listAt={cfgs.at.get(dir) ?? 0}
      runs={runs}
      // The buffer itself (read-only, moved in place); `outTick` says when to look again.
      output={builds.output}
      outTick={outTick}
      online={core.conn.status === "open"}
      onSave={(b) => saveBuilds(dir, b)}
      onRun={(id, params) => runBuild(dir, id, params)}
      onCancel={cancelBuild}
      onDownload={(a: BuildArtifact) => core.files.downloadArtifact(a)}
      onSetup={(prompt) => setupBuilds(repo, prompt)}
      candidates={cands?.list ?? null}
      candidatesTotal={cands?.total ?? 0}
      paramOptions={opts}
      policy={policy}
      onSavePolicy={(p) => savePolicy(dir, p)}
      onAskOptions={(buildId) => askOptions(dir, buildId)}
      onScan={() => scanRepo(dir)}
      onClose={() => core.nav.close("build")}
    />
  );
}
