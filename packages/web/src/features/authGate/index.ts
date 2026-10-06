/**
 * The LAN password gate as a feature: the gate state leaves App, App keeps the
 * one line that lets it take the whole screen. See README.md.
 */
import type { FeatureManifest } from "../../sdk";
import { gate } from "./store";

export { AuthGate } from "./AuthGate";
export { useAuthGate, type AuthGateState } from "./store";

export const manifest: FeatureManifest = {
  id: "authGate",
  messages: {
    authRequired: (msg) => gate.set({ enabled: msg.enabled, kind: msg.kind }),
    // A welcome means the host let this connection in: whatever gated the last
    // one is over. (App's own `welcome` case still takes `msg.auth`.)
    welcome: () => gate.set(null),
  },
};
