/**
 * Skills & plugins: what every new session of a repo carries, and the switches for it — Setup &
 * health's `Skills` section. The `skills` overlay draws the one frame (`SetupHealthSheet.tsx`) on
 * that section. README.md says what this owns and which rules apply.
 */
import { createElement } from "react";
import { core, keepStores, type FeatureManifest } from "../../sdk";
import { SkillsSheet } from "./SkillsSheet";
import { skillsAim } from "../../skillsDoor";
import { SetupHealthSheet } from "../../SetupHealthSheet";
import { healthPlace, leaveHealth, registerHealthBody } from "../../setupHealth";
import { closeSkills, enterSkills } from "./actions";
import { skillsEmbedAim, skillsState } from "./store";

registerHealthBody("skills", {
  // A skills door opened this overlay and no section tap has moved it since: the door's aim. Otherwise the section's.
  render: () => createElement(SkillsSheet, { embedded: true, fromDoor: core().nav.overlay === "skills" && healthPlace.get()?.self !== "skills" }),
  repoId: () => skillsState.get().repoId,
  enter: enterSkills,
});

export const manifest: FeatureManifest = {
  id: "skills",
  sheets: [
    // Aimed at a repo by a door (`skillsDoor.ts`); with none in memory this returns null and falls
    // through to the screen underneath, like `assess`. A reload goes back to its door.
    { id: "skills", persisted: false, keep: keepStores(skillsEmbedAim, healthPlace),
      onLeave: (r) => { if (r === "close") leaveHealth("skills"); },
      render: () => (skillsAim.get() ? createElement(SetupHealthSheet, { self: "skills", landing: { tab: "repo", section: "skills" }, onClose: closeSkills }) : null) },
  ],
};
