/**
 * "Restart when idle" for a session running an older `claude` than the one
 * installed. README.md says what this owns and which rules apply.
 */
import type { FeatureManifest } from "../../sdk";
import { stopTicking } from "./actions";

export { armRestart, disarmRestart } from "./actions";
export { useArmedRestart } from "./store";

export const manifest: FeatureManifest = {
  id: "cliRestart",
  // The check runs on its own timer while a session is armed (`actions.ts`).
  boot: () => stopTicking,
};
