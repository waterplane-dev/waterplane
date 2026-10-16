/**
 * The code folder: the one-time "which folder holds your repos?" dialog, and Settings → Code
 * folder, the way back to it. README.md says what this owns.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { CodeFolderSheet } from "./CodeFolderSheet";
import { CodeFolderSettings } from "./CodeFolderSettings";
import { leaveCodeFolder, onWelcome } from "./actions";

export { openCodeFolder } from "./actions";

export const manifest: FeatureManifest = {
  id: "codeFolder",
  // Never restored from the URL: a reload is a "later", and the dialog is a question about a
  // folder, asked from a live host (`hostedack`'s reason).
  sheets: [{ id: "codefolder", persisted: false, render: () => createElement(CodeFolderSheet), onLeave: leaveCodeFolder }],
  // The phone is connected exactly when this can be asked; the same frame ends a restart wait.
  messages: { welcome: (msg) => onWelcome(msg.root) },
  settings: [
    // Head of Connection, after the host list (-20) and the host tools' head (-10): which desktop, then what it scans.
    { group: "connection", order: -5, render: () => createElement(CodeFolderSettings) },
  ],
};
