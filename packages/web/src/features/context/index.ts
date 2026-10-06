/**
 * The context window as a shape: the `context` sheet for one session — the
 * attached one (header chip) or a launcher row's (its cost tile). README.md
 * says what it owns and which rules apply.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { ContextEntrySheet } from "./ContextEntrySheet";
import { contextSubject } from "./logic";
import { ctxSid } from "./store";

export { openContext, openContextFor } from "./actions";

export const manifest: FeatureManifest = {
  id: "context",
  sheets: [
    // Scoped to ONE session, and guarded rather than defaulted: a miss here
    // returns null and falls through to the screen underneath, which is what
    // the overlay table's whole shape relies on (an overlay whose backing
    // state is gone paints the screen below, never an empty sheet).
    { id: "context", persisted: true, render: (c) => {
      const subject = contextSubject(ctxSid.get(), c.world.sessions, c.world.active);
      return subject ? createElement(ContextEntrySheet, { subject }) : null;
    } },
  ],
};
