/**
 * Background shells under a session: the `shells` sheet and its two receipts
 * — README.md says what it owns and which rules apply.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { ShellsSheet } from "./ShellsSheet";
import { shellsSubject } from "./logic";
import { shellsSid } from "./store";
import { onSessionClosed, onShellKilled } from "./actions";

export { lineToShell, noteSessionClosing, openShells, openShellsFor } from "./actions";

export const manifest: FeatureManifest = {
  id: "shells",
  sheets: [
    // Session-scoped, guarded rather than defaulted: a miss falls through to
    // the screen underneath rather than painting an empty sheet — the same
    // rule `context`'s own sheet follows.
    { id: "shells", persisted: false, render: (c) => {
      const subject = shellsSubject(shellsSid.get(), c.world.sessions, c.world.active);
      return subject ? createElement(ShellsSheet, { subject }) : null;
    } },
  ],
  messages: {
    "shell.killed": (msg) => onShellKilled(msg),
    "session.closed": (msg) => onSessionClosed(msg.id, msg.shellsStopped, msg.shellsLeft),
  },
};
