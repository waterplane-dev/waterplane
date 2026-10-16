/**
 * Build your first app (`docs/analysis/first-app-plan.md`, WP7): the first-run card, the three
 * questions, the consent screen, the progress checklist and the hand-off. README.md says what it
 * owns; the job itself is the desktop's (`host/onboard.ts`).
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { OnboardSheet } from "./OnboardSheet";
import { refreshJob, takeJob } from "./actions";

export { FirstRunCard } from "./FirstRunCard";
export { openOnboard } from "./actions";
export { useOnboardJob } from "./store";
export { neverRanSession } from "./logic";

export const manifest: FeatureManifest = {
  id: "onboard",
  sheets: [
    // Never restored from the URL: it is a consent screen standing between a tap and a job (`hostedack`'s
    // reason), and a running job is found again from the launcher's card, not from the URL.
    { id: "onboard", persisted: false, render: () => createElement(OnboardSheet) },
  ],
  messages: {
    "onboard.progress": (msg) => takeJob(msg.job),
    // A reconnect: the job may have moved on (or finished) while the link was down.
    welcome: () => { void refreshJob(); },
  },
};
