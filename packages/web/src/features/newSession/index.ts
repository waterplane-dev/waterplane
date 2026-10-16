/**
 * Ctrl/⌘/Alt+N opens a new session from the keyboard — see README.md.
 */
import type { FeatureManifest } from "../../sdk";
import { installNewKey, registerNewKeyShortcut } from "./actions";

export const manifest: FeatureManifest = {
  id: "newSession",
  boot: () => {
    const offKey = installNewKey();
    const offRow = registerNewKeyShortcut();
    return () => { offKey(); offRow(); };
  },
};
