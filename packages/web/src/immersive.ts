/**
 * The Android shell's system bars (status + navigation) hidden or back, for a view that wants the
 * whole glass — the live desktop's fullscreen. A WebView ignores `requestFullscreen` here
 * (Capacitor's chrome client dismisses the custom view at once), so the shell takes the push
 * instead: `ShellAndroidInterface.setImmersive`. Hidden bars come back for a moment on a swipe from
 * the edge. An older APK has no such method; the call is then a no-op and says so (`false`).
 */
import { shellInterface } from "./shellBridge";

export function shellImmersive(on: boolean): boolean {
  const iface = shellInterface<{ setImmersive?: (on: boolean) => void }>();
  if (!iface?.setImmersive) return false;
  iface.setImmersive(on);
  return true;
}
