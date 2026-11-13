/**
 * Skills & plugins: what every new session of a repo carries, and the switches for it. README.md
 * says what this owns and which rules apply.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { SkillsSheet } from "./SkillsSheet";
import { skillsAim } from "../../skillsDoor";

export const manifest: FeatureManifest = {
  id: "skills",
  sheets: [
    // Aimed at a repo by a door (`skillsDoor.ts`); with none in memory this returns null and falls
    // through to the screen underneath, like `assess`. A reload goes back to its door.
    { id: "skills", persisted: false, render: () => (skillsAim.get() ? createElement(SkillsSheet) : null) },
  ],
};

