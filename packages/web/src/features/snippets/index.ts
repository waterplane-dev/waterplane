/**
 * Compose snippets: the saved texts the compose bar's snippet popover inserts,
 * and the `snippets` sheet that manages them. README.md says what it owns.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { SnippetsSheet } from "./SnippetsSheet";
import { bootSnippetSync } from "./actions";

export { useSnippets } from "./store";

export const manifest: FeatureManifest = {
  id: "snippets",
  sheets: [
    { id: "snippets", persisted: false, render: () => createElement(SnippetsSheet) },
  ],
  boot: () => bootSnippetSync(),
};
