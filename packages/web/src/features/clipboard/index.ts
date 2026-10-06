/**
 * Text in and out of the session: the Terminal-text sheet (copy, quote, follow
 * a link) and the To-desktop-clipboard sheet. README.md says what it owns.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { ClipSheet } from "./ClipSheet";
import { DecisionsSheet } from "./DecisionsSheet";
import { TextSheet } from "./TextSheet";
import { openClipSheet, openDecisions, openTextDump } from "./actions";

export { copyCode, copyLink, openClipSheet, openDecisions, openLink, openTextDump, quoteIntoCompose } from "./actions";

export const manifest: FeatureManifest = {
  id: "clipboard",
  sheets: [
    { id: "clip", persisted: false, render: () => createElement(ClipSheet) },
    { id: "text", persisted: false, render: () => createElement(TextSheet) },
    { id: "answers", persisted: false, render: () => createElement(DecisionsSheet) },
  ],
  commands: [
    { id: "clip", run: () => openClipSheet() },
    { id: "select", run: () => { void openTextDump(); } },
    { id: "decide", run: () => { void openDecisions(); } },
  ],
};
