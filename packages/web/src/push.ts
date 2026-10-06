import { api } from "./api";
import { isNativeShell } from "./hostUrl";
import { isDemo } from "./demo/mode";
/** Web Push subscription from the browser side. */

function urlB64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const arr = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

/**
 * The APK has no Web Push, and `"serviceWorker" in navigator` does not know it.
 *
 * `main.tsx` registers no service worker in the native shell — on purpose: the
 * shell ships inside the APK, so a worker caching it buys nothing and would put
 * a second, stale copy in front of the one the APK serves. But the WebView
 * still EXPOSES `navigator.serviceWorker`, so every feature test below passed
 * and `await navigator.serviceWorker.ready` then waited on a registration that
 * is never coming. Not a rejection — a promise that never settles.
 *
 * What that looked like: the settings row sat at its initial `off`, which reads
 * as an invitation, and tapping it called `enablePush()` — which hung in the
 * same place, so there was no toast, no change and no error. A dead control
 * claiming a feature the build does not have.
 *
 * So the shell is its own status. Alerts there come from `ShellLinkService`
 * (`shellLink.ts`), which is a different channel with a different failure mode,
 * and the settings row says so instead of offering a switch.
 */
export function nativeNoPush(): boolean {
  return isNativeShell();
}

export function pushSupported(): boolean {
  if (nativeNoPush()) return false;
  // The demo never subscribes: a subscription is a request to the browser's
  // push service (FCM), off this device, for a desktop that is not there.
  if (isDemo()) return false;
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** Web Push requires a secure context (https or localhost). Plain http over
 *  Tailscale is NOT secure, so serviceWorker/PushManager are absent there. */
export function secureContext(): boolean {
  return typeof window !== "undefined" && window.isSecureContext;
}

export type PushStatus = "on" | "off" | "denied" | "insecure" | "unsupported" | "native" | "demo";

export async function pushStatus(): Promise<PushStatus> {
  // Before the secure-context test, which the shell PASSES (capacitor:// and
  // http://localhost are both secure) — so "insecure" would be a wrong reason
  // for a right refusal, and the fix it offers (front it with TLS) does nothing.
  // Before "native" too: in the shell's demo the background link is not running
  // either, so neither sentence about real alerts would be true.
  if (isDemo()) return "demo";
  if (nativeNoPush()) return "native";
  if (!secureContext()) return "insecure"; // root cause #1: http over Tailscale
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    const reg = await navigator.serviceWorker.ready;
    return (await reg.pushManager.getSubscription()) ? "on" : "off";
  } catch {
    return "off";
  }
}

export async function enablePush(): Promise<boolean> {
  if (!pushSupported()) return false;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return false;
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api.push.key();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlB64ToUint8Array(key),
  });
  await api.push.subscribe(sub);
  return true;
}

export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await api.push.unsubscribe(sub.endpoint);
  await sub.unsubscribe();
}
