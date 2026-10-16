/**
 * Ask rules — the desktop-wide list of commands claude must ask about first
 * (docs/plans/agent-authority.md §2), as a Settings row. README.md says what
 * this owns and which rules apply.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { AskRulesSettings } from "./AskRulesSettings";

export const manifest: FeatureManifest = {
  id: "askRules",
  settings: [
    // After the launch rows, billing and limits; before auto-compact: what a
    // claude session may do without asking is a question about every launch.
    { group: "sessions", order: 20, render: () => createElement(AskRulesSettings) },
  ],
};
