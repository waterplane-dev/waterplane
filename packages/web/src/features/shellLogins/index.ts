/**
 * The logins cheat sheet for shell sessions — README.md says what it owns.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { LoginsSheet } from "./LoginsSheet";
import { openLogins } from "./actions";

export { openLogins } from "./actions";

export const manifest: FeatureManifest = {
  id: "shellLogins",
  sheets: [{ id: "logins", persisted: false, render: () => createElement(LoginsSheet) }],
  commands: [{ id: "logins", run: () => openLogins() }],
};
