/**
 * Verified capture: a repo's screenshot targets, the runs (one-shot or watch)
 * and their streamed output. README.md says what this owns and which rules apply.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { b64ToStr } from "../../format";
import { VerifiedCaptureSheet } from "./VerifiedCaptureSheet";
import { captureRepo, captures } from "./store";
import { onCaptureList, onCaptureRun, resyncCapture } from "./actions";

export { openCaptureFor } from "./actions";

export const manifest: FeatureManifest = {
  id: "capture",
  sheets: [
    // Repo-scoped and guarded exactly like `build`: with no repo in memory this
    // returns null and falls through to the screen underneath.
    { id: "capture", persisted: false, render: () => {
      const repo = captureRepo.get();
      return repo ? createElement(VerifiedCaptureSheet, { repo }) : null;
    } },
  ],
  messages: {
    welcome: () => resyncCapture(),
    "capture.list": (msg) => onCaptureList(msg.repoDir, msg.targets, msg.runs, msg.backends),
    "capture.run": (msg, c) => onCaptureRun(msg.run, c),
    // Only re-render while the sheet is actually on screen — otherwise a chatty
    // backend re-renders per output chunk for nothing.
    "capture.output": (msg, c) =>
      captures.onOutput(msg.runId, b64ToStr(msg.dataB64), !!msg.full, c.nav.overlay === "capture"),
  },
};
