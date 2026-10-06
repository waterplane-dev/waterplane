/**
 * "Share → waterplane" from another app (the Android share sheet): ask where it
 * goes, then attach it as the compose bar would. README.md says what it owns.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { shared } from "./store";
import { bootShare } from "./actions";
import { ShareInSheet } from "./ShareInSheet";

export const manifest: FeatureManifest = {
  id: "share",
  sheets: [
    // Guarded: a restored route with no share behind it falls through.
    { id: "share", persisted: false, render: () => (shared.get() ? createElement(ShareInSheet) : null) },
  ],
  boot: bootShare,
};
