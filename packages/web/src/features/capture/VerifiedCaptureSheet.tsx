/**
 * The `capture` overlay: `CaptureSheet.tsx` wired to this feature's stores and
 * actions — the prop list `App.tsx`'s `overlayViews.capture` used to spell out.
 */
import { useMemo } from "react";
import type { BuildArtifact, RepoTarget } from "@waterplane/shared";
import { useCore, useStore } from "../../sdk";
import { CaptureSheet } from "../../CaptureSheet";
import { captureBackends, captures } from "./store";
import { cancelCapture, runCapture, saveTargets, setupCaptureWithAgent } from "./actions";

export function VerifiedCaptureSheet({ repo }: { repo: RepoTarget }) {
  const core = useCore();
  const dir = repo.worktreePath;
  const cfgs = useStore(captures.cfgs);
  const allRuns = useStore(captures.runs);
  const outTick = useStore(captures.outTick);
  const backends = useStore(captureBackends).get(dir);
  const runs = useMemo(() => allRuns.filter((r) => r.repoDir === dir), [allRuns, dir]);
  return (
    <CaptureSheet
      repo={repo}
      targets={cfgs.lists.get(dir) ?? []}
      listAt={cfgs.at.get(dir) ?? 0}
      runs={runs}
      // Never cached and never defaulted: an empty array is "nobody has said",
      // which the sheet words apart from "said no". Inventing an `available:
      // false` here would print a reason this desktop never gave.
      backends={backends ?? []}
      // The buffer itself (read-only, moved in place); `outTick` says when to look again.
      output={captures.output}
      outTick={outTick}
      online={core.conn.status === "open"}
      onSave={(t) => saveTargets(dir, t)}
      onRun={(id, watch) => runCapture(dir, id, watch)}
      onCancel={cancelCapture}
      onSetup={() => setupCaptureWithAgent(repo)}
      onDownload={(a: BuildArtifact) => core.files.downloadArtifact(a)}
      onClose={() => core.nav.close("capture")}
    />
  );
}
