/**
 * The queue sheet: the phone's send queue, row by row, and the launches the
 * desktop is holding. README.md says what it reads and which rules apply.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { SendQueueSheet } from "./SendQueueSheet";

export const manifest: FeatureManifest = {
  id: "queue",
  sheets: [{ id: "queue", persisted: false, render: () => createElement(SendQueueSheet) }],
};
