/**
 * The local scrollback archive's sheet — README.md.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { ScrollArchiveSheet } from "./ScrollArchiveSheet";

export { openScrollback } from "./actions";

export const manifest: FeatureManifest = {
  id: "scrollback",
  sheets: [
    // Session-scoped: with no session on screen this falls through to the
    // screen underneath rather than painting an empty sheet.
    { id: "scrollback", persisted: false, render: (c) => {
      const active = c.world.active;
      return active ? createElement(ScrollArchiveSheet, { active }) : null;
    } },
  ],
};
