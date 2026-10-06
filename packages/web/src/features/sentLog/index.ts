/**
 * The sent-command audit log — see README.md.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { onSentNew, openSentForActive } from "./actions";
import { entries } from "./store";
import { SentCommandsSheet } from "./SentCommandsSheet";

export { openSentLog } from "./actions";

export const manifest: FeatureManifest = {
  id: "sentLog",
  sheets: [{ id: "sentlog", persisted: false, render: () => createElement(SentCommandsSheet) }],
  commands: [{ id: "sent", run: openSentForActive }],
  messages: {
    "sent.log": (msg) => entries.set(msg.entries),
    "sent.new": (msg) => onSentNew(msg.entry),
  },
};
