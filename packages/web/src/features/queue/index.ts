/**
 * The queue sheet: the phone's send queue, row by row, and the launches the
 * desktop is holding. README.md says what it reads and which rules apply.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { SendQueueSheet } from "./SendQueueSheet";
import { registerWaitingBody } from "../../waitingWork";
import { waitingSheet } from "../../WaitingFrame";

// The Queued tab of Waiting work (journey spec D4).
registerWaitingBody("queued", { render: () => createElement(SendQueueSheet) });

export const manifest: FeatureManifest = {
  id: "queue",
  // An alias id: Waiting work on its Queued tab.
  sheets: [{ id: "queue", persisted: false, ...waitingSheet("queue") }],
};
