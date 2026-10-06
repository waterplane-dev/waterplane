/**
 * Build buttons: a repo's sessionless build commands, their runs and their
 * streamed output. README.md says what this owns and which rules apply.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { b64ToStr } from "../../format";
import { BuildButtonsSheet } from "./BuildButtonsSheet";
import { buildRepo, builds } from "./store";
import { onArtifactsConfig, onBuildCandidates, onBuildOptions, onBuildRun, openBuildFor, resyncBuild } from "./actions";

export { buildNameOf, useBuildNames } from "./store";
export { openBuildFor } from "./actions";
export { buildLane, buildQueueTitle, buildQueuedToast } from "./logic";

export const manifest: FeatureManifest = {
  id: "build",
  sheets: [
    // Repo-scoped: with no repo in memory this returns null and falls through
    // to the screen underneath, rather than painting an empty sheet.
    { id: "build", persisted: false, render: () => {
      const repo = buildRepo.get();
      return repo ? createElement(BuildButtonsSheet, { repo }) : null;
    } },
  ],
  commands: [
    { id: "build", run: (c) => { const r = c.world.activeRepo; if (r) openBuildFor(r); else c.say.toast("not a known repo"); } },
  ],
  messages: {
    // A reconnect: re-ask the open sheet's list, so the host replays each run's
    // retained tail (`full: true`) and the chunks sent into the gap are not lost.
    welcome: () => resyncBuild(),
    "artifacts.config": (msg) => onArtifactsConfig(msg.repoDir, msg.policy),
    "build.list": (msg) => builds.onList(msg.repoDir, msg.builds, msg.runs),
    "build.options": (msg) => onBuildOptions(msg.repoDir, msg.buildId, msg.options),
    "build.candidates": (msg) => onBuildCandidates(msg.repoDir, msg.candidates, msg.total),
    "build.run": (msg, c) => onBuildRun(msg.run, c),
    // Only re-render when the build sheet is actually on screen — otherwise a
    // chatty build would re-render per output chunk for nothing. The buffer
    // still moves, so opening the sheet shows everything.
    "build.output": (msg, c) =>
      builds.onOutput(msg.runId, b64ToStr(msg.dataB64), !!msg.full, c.nav.overlay === "build"),
  },
};
