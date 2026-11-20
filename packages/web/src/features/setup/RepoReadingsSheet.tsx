/**
 * The readings regions (`SetupSheet.tsx`: Health score, Watch, Opt-ins, Sessions) as sections of
 * Setup & health (`SetupHealthSheet.tsx`), wired to this feature's aim and the core. The `setup`
 * overlay, its `repohealth` alias and the `health` id all draw the one frame; this is the body it
 * shows for those four sections. `remedy` and `openRepoFile` are shared on purpose: every door gets
 * the same verbs.
 */
import { SetupSheet } from "../../SetupSheet";
import { useCore, useStore } from "../../sdk";
import { CLAUDE, skillSwitchGate } from "../../backendCaps";
import { regionOfSection, type HealthPlace } from "../../setupHealth";
import { healthRepo, setupAim, setupRepo } from "./store";
import {
  closeSetup, openAllSessions, openInstructionFile, openRepoFile, remedy, seedSend, sessionDoorsFor, toSkillsSection,
} from "./actions";

export function ReadingsBody({ place }: { place: HealthPlace }) {
  const core = useCore();
  // Repos run claude unless a session says otherwise; this door is the repo's, so claude's fact decides.
  const skillsGate = skillSwitchGate(core.world.backends, CLAUDE);
  const repoId = useStore(setupRepo);
  const alias = useStore(healthRepo);
  const aim = useStore(setupAim);
  return <SetupSheet embedded repos={core.world.repos} initialRepoId={repoId ?? alias?.id ?? undefined}
    initialRegion={regionOfSection(place.section)} focus={aim.focus}
    // A finding whose answer is WORK, handed to the one send surface rather
    // than run from the checklist: the sheet states what it found, this opens
    // the prompt with the repo already chosen, and WHEN it runs is still a
    // decision made with the words on screen.
    onRemedy={remedy}
    onOpenFile={openRepoFile}
    onSeed={seedSend}
    // The context-weight row's doors: what a live session of this repo carried, and every session.
    sessionDoorsFor={sessionDoorsFor}
    onAllSessions={openAllSessions}
    onSkills={skillsGate ? undefined : toSkillsSection}
    skillsCant={skillsGate}
    onOpenInstructionFile={openInstructionFile}
    onRepoChange={(id) => setupRepo.set(id)}
    onClose={closeSetup} />;
}
