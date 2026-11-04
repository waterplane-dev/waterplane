/**
 * The optional fingerprint lock on the Android app. See README.md.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { AppLockSettings } from "./AppLockSettings";
import { TokenSealSettings } from "./TokenSealSettings";

export { AppLockGate, SealGate } from "./AppLockGate";
export { appLockAdapter, appLockOn, armAppLock, clearSealLostNote, openWithoutTokens, rewrapAfterPair, sealLostNote, sealTokens, unlockSignIns, unsealTokens } from "./actions";
export { useAppLock, useSealWaiting } from "./store";
export type { SwitchRefusal, SwitchResult } from "./logic";

export const manifest: FeatureManifest = {
  id: "appLock",
  settings: [
    // After the LAN password rows: it guards this phone, not the host.
    { group: "connection", order: 10, render: () => createElement(AppLockSettings) },
    { group: "connection", order: 11, render: () => createElement(TokenSealSettings) },
  ],
};
