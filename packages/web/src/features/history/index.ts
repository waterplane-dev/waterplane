/**
 * A session's prompt history: the `history` sheet and its store — README.md.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { PromptHistorySheet } from "./PromptHistorySheet";

export { noteHistory } from "./actions";

export const manifest: FeatureManifest = {
  id: "history",
  sheets: [
    // Session-scoped: with no session on screen this falls through to the
    // screen underneath rather than painting an empty sheet.
    { id: "history", persisted: false, render: (c) => {
      const active = c.world.active;
      return active ? createElement(PromptHistorySheet, { active }) : null;
    } },
  ],
};
