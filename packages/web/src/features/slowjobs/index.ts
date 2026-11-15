/**
 * Slow jobs — the wire half of `src/slowJobs.ts`: the `slowjob.state` frame on the one socket, the
 * catch-up after a reconnect, and the toast when a run somebody waited on ends while they are on
 * another screen. README.md says what this owns.
 */
import type { FeatureManifest } from "../../sdk";
import { core } from "../../sdk";
import { onSlowJobFrame, onSlowJobSettled, resyncSlowJobs } from "../../slowJobs";
import { screenFor, toastFor } from "./logic";

function bootToasts(): () => void {
  return onSlowJobSettled((s) => {
    const c = core();
    const repoName = c.world.repos.find((r) => r.id === s.repoId)?.repoName ?? s.repoId;
    const words = toastFor({ kind: s.kind, state: s.job.state, asked: s.asked, watched: s.watched, error: s.job.error }, repoName);
    if (!words) return;
    const open = screenFor(s.kind) === "setup" ? () => c.nav.openSetup(s.repoId, { region: "setup" }) : () => c.nav.openSkills(s.repoId);
    c.say.toast(words, undefined, open);
  });
}

export const manifest: FeatureManifest = {
  id: "slowjobs",
  boot: bootToasts,
  messages: {
    // Frames missed while the socket was down: the host's list is the catch-up.
    welcome: () => { void resyncSlowJobs(); },
    "slowjob.state": (msg) => onSlowJobFrame(msg.job),
  },
};
