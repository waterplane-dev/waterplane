/**
 * The capture feature's sentences, pure so they can be pinned without a DOM or
 * a socket (`logic.test.mjs`). Every one was an inline literal in `App.tsx`.
 */
import { BRAND, type CaptureBackendInfo, type CaptureRun, type CaptureTarget } from "@waterplane/shared";

/** A capture's queue lane: the repo's, because the lease a capture takes (a
 *  browser, a simulator, the desktop's screen) is one per repo, whether it is
 *  a one-shot or a watch. */
export const captureLane = (repoDir: string): string => `capture:${repoDir}`;

/** What the queue row is CALLED. A watch says it is one — it keeps going. */
export const captureQueueTitle = (name: string, watch: boolean): string =>
  watch ? `watch “${name}”` : `capture “${name}”`;

/**
 * The receipt for a tapped capture. Both halves, not just the offline one: on a
 * slow link a tapped capture looked like a dead button until the host's first
 * `capture.run` frame came back. A watch says what it will keep doing, because
 * the thing you have to remember is that it is still going and yours to stop.
 */
export function captureQueuedToast(offline: boolean, watch: boolean, name: string): string {
  if (offline) return watch ? "queued — the watch starts when the link is back" : "queued — the capture runs when the link is back";
  return watch ? `watching “${name}” — a frame is kept each time the screen changes` : `capturing “${name}”…`;
}

/**
 * A `capture.run` push's toast. The VERDICT is the point of a capture, so the
 * toast carries it — whole and verbatim, the host's one wording, never
 * re-derived or cut at its separator here. A finished run with no verdict yet
 * says only that it finished, rather than inventing one. `null`: stay quiet.
 */
export function captureRunToast(run: Pick<CaptureRun, "status" | "name" | "verdict">): string | null {
  if (run.status === "done") return run.verdict ? `“${run.name}” — ${run.verdict}` : `capture “${run.name}” done`;
  if (run.status === "failed") return run.verdict ? `“${run.name}” failed — ${run.verdict}` : `capture “${run.name}” failed`;
  return null;
}

/** A target's display name by id in a repo's cached list; the id when absent. */
export function captureNameIn(lists: ReadonlyMap<string, readonly CaptureTarget[]>, dir: string, id: string): string {
  return (lists.get(dir) ?? []).find((t) => t.id === id)?.name ?? id;
}

/**
 * "Set up with AI": the words a new session in the repo is seeded with. It
 * carries the file's shape in full, because the driven repo cannot read this
 * repo's types, and what THIS desktop said it can drive, so the agent does not
 * pick a backend the host has already refused. An empty `backends` is "nobody
 * has said" and the prompt says nothing either way rather than guessing.
 */
export function captureSetupPrompt(repoName: string, backends: readonly CaptureBackendInfo[], existing: number): string {
  const file = `${BRAND.stateDirName}/capture.json`;
  const can = backends.map((b) => `- ${b.id}: ${b.available ? "available" : "NOT available"}${b.reason ? ` — ${b.reason}` : ""}`);
  return [
    `Set up ${BRAND.displayName}'s verified capture for ${repoName}, so the phone can screenshot the running app with one tap.`,
    "",
    existing > 0
      ? `There are already ${existing} target(s) in ${file} — keep them, add what is missing.`
      : `Write ${file} (or the capture.json in an older ${BRAND.displayName} state dir, if this repo already has one).`,
    "",
    "Shape: { \"version\": 1, \"targets\": [ … ] }. Each target:",
    "- id (stable, short, unique), name (the button label, e.g. \"app · home\"), backend: web | android | garmin | window",
    "- dir: working dir relative to the repo root (optional; one target per app in a monorepo)",
    "- anchor: [\"text that must be on that screen\"] — this is what makes a capture *verified* rather than merely taken; pick words really rendered there",
    "- web: url (required, loopback only, e.g. http://localhost:5173/), viewports [{\"w\":390,\"h\":844}, …], theme light | dark | both",
    "- android: serial (only when more than one device is attached) · garmin: screen, device · window: windowTitle",
    "",
    ...(can.length ? ["What this desktop says it can drive:", ...can, ""] : []),
    "Steps: find how this repo's app(s) run and on which port; choose one or two screens that matter, each with an anchor; if web needs Playwright and it is missing, add it as a dev dependency. Then start the app, trigger one capture per target with the capture/run endpoint (wait: true), and fix the target until the verdict says verified. Report each target's verdict in one line — read the sidecar, not the image.",
  ].join("\n");
}
