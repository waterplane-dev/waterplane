/**
 * Fan-out: one prompt run in several repos at once, a fresh session each, and
 * follow-ups to the sessions a sweep opened. README.md says what it owns.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { FanoutEntrySheet } from "./FanoutEntrySheet";

export const manifest: FeatureManifest = {
  id: "fanout",
  sheets: [
    { id: "fanout", persisted: false, render: () => createElement(FanoutEntrySheet) },
  ],
};
