/**
 * The host tools' state: how this phone gets alerts. Written only by
 * `actions.ts`; read by the Settings rows (`useHostPush`, `useShellLink`).
 */
import type { PushStatus } from "../../push";
import type { ShellLinkStatus } from "../../shellLink";
import { createStore, useStore } from "../../sdk";

/** Web Push on this document, as `push.ts` last answered. */
export const push = createStore<PushStatus>("off");
/**
 * The APK's background link. `null` everywhere it cannot exist — every browser,
 * and an APK whose binary predates the plugin — which is what the settings
 * section branches on. Web Push is the browser's answer to the same question
 * and `push.ts` already gives it, so the two are never both offered.
 */
export const shellLink = createStore<ShellLinkStatus | null>(null);

export function useHostPush(): PushStatus {
  return useStore(push);
}
export function useShellLink(): ShellLinkStatus | null {
  return useStore(shellLink);
}
