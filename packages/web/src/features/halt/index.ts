/**
 * The emergency halt's phone half: the latch's state, the banner while it
 * holds, and the two places it is started from. README.md says what this owns
 * and which rules apply.
 */
import { OctagonX } from "lucide-react";
import type { FeatureManifest } from "../../sdk";
import { askHalt, onHaltState } from "./actions";

export { useHalt } from "./store";
export { liftHalt } from "./actions";
export { haltBannerWords } from "./logic";

export const manifest: FeatureManifest = {
  id: "halt",
  messages: {
    "halt.state": (msg) => onHaltState(msg.halt),
  },
  // One tap from home and one from any session, each behind the confirm.
  launcherItems: [{ id: "halt", label: "Halt", icon: OctagonX, order: 90, open: () => void askHalt() }],
  menuItems: [{ id: "halt", label: "halt all AI", icon: OctagonX, order: 90, open: () => void askHalt() }],
};
