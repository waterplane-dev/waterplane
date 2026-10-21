/**
 * The background link — the half that isn't Java.
 *
 * Backgrounded, the APK used to do nothing at all. Not for one reason but for a
 * chain of them, and the middle link is the one that matters: with no foreground
 * service the process drops to Android's cached bucket within minutes and the
 * **cached-app freezer suspends the whole thing** — JS, timers, the socket.
 * `ws.ts` even anticipates its own death; its `freeze` handler closes the socket
 * on the way down. Capacitor is not the problem (`KeepRunning` defaults to
 * true); the process being frozen is.
 *
 * `ShellLinkService` fixes that by existing, and this module is how the page asks
 * for it. Two directions:
 *
 *  - **Out**: switch the service on, point it at the host, tell it how deep the
 *    send queue is. Everything it needs is a parameter, because none of it is a
 *    fact about the APK — `PROTOCOL_VERSION` ships in the over-the-air bundle
 *    while the binary does not update, and the host address lives in this
 *    page's own localStorage. A constant on the Java side would drift.
 *  - **In**: two globals the shell calls. `shellNudge` wakes `ws.ts` when
 *    the phone's network changed — `ws.ts` verifies its socket on
 *    `visibilitychange`, `online`, `focus` and `pageshow`, every one of them a
 *    VIEWPORT event, so a page that is alive but not on screen when the network
 *    flaps gets no signal at all. `shellOpen` is a tapped notification
 *    asking for a session, the same errand `sw.js`'s `notificationclick` runs
 *    in the browser.
 *
 * Both arrive as ordinary `window` events, so the modules that act on them
 * (`ws.ts`, `App.tsx`) need no import from here and no knowledge that a native
 * shell exists. And both are **optional at the far end**: the shell guards its
 * own calls, because the UI updates over the air and the APK does not — a
 * bundle that has never heard of either global must be exactly as well off as
 * it was before.
 *
 * As with `hostUrl.ts`, `webUpdate.ts` and `nativeSave.ts`, the plugin is
 * reached off the global Capacitor injects rather than an npm import: no
 * native-shell dependency enters the bundle every browser downloads.
 */
import { PROTOCOL_VERSION, wsUrlFor, type PairTarget } from "@waterplane/shared";
import { isNativeShell, savedHostBase } from "./hostUrl";
import { isDemo } from "./demo/mode";
import { PAIR_LINK_INVALID, pairLinkRequest } from "./pairRedeem";
import { defineShellGlobal, nativePlugin } from "./shellBridge";
import { showToast } from "./toast";

/** The shell nudged us: the phone's network changed while nobody was looking.
 *  `ws.ts` listens for this beside its four viewport events. */
export const SHELL_NUDGE_EVENT = "app:shell-nudge";
/** A tapped OS notification wants a session opened. `detail.sessionId`. */
export const SHELL_OPEN_EVENT = "app:shell-open";

/** What `ShellLink.status()` answers. Every field is a fact the settings row
 *  shows; none of it is derived twice. */
export interface ShellLinkStatus {
  supported: boolean;
  enabled: boolean;
  running: boolean;
  /** `stopped` | `starting` | `connecting` | `connected` | `reconnecting` |
   *  `auth` (the host wants the LAN password) | `unconfigured`. */
  state: string;
  host: string | null;
  queueDepth: number;
  connectedAt?: number;
  lastFrameAt?: number;
  error?: string;
  /** POST_NOTIFICATIONS. False is not fatal — see `enableShellLink`. */
  notifications: boolean;
  /** Exempt from battery optimisation. False is not fatal either. */
  batteryExempt: boolean;
}

interface LinkPlugin {
  /** `powerSave` is absent on a shell older than the tab-sync offer. */
  isSupported(): Promise<{ supported: boolean; notifications: boolean; batteryExempt: boolean; powerSave?: boolean }>;
  status(): Promise<ShellLinkStatus>;
  start(opts: { url: string; protocol: number; label: string }): Promise<ShellLinkStatus>;
  stop(): Promise<void>;
  setQueueDepth(opts: { depth: number }): Promise<void>;
  requestNotifications(): Promise<{ granted: boolean }>;
  requestBatteryExemption(): Promise<void>;
  /** Absent on a shell older than the phone-setup checklist. */
  openNotificationSettings?(): Promise<void>;
}

function plugin(): LinkPlugin | null {
  // The demo starts no background link and tells it nothing (no queue depth):
  // the service dials a desktop directly, around the demo transport.
  if (isDemo()) return null;
  const p = nativePlugin<LinkPlugin>("Link");
  return p && typeof p.start === "function" ? p : null;
}

/** Can this device keep a link open with the app closed? False in every
 *  browser, where Web Push is the answer and `push.ts` already gives it. */
export function shellLinkSupported(): boolean {
  return isNativeShell() && plugin() !== null;
}

/** Is the phone's battery saver on? Null in a browser, or a shell too old to say. */
export async function phonePowerSave(): Promise<boolean | null> {
  const p = plugin();
  if (!p) return null;
  try {
    const r = await p.isSupported();
    return typeof r.powerSave === "boolean" ? r.powerSave : null;
  } catch {
    return null;
  }
}

/** What the link is doing right now, or null where there is no link to ask. */
export async function shellLinkStatus(): Promise<ShellLinkStatus | null> {
  const p = plugin();
  if (!p) return null;
  try {
    return await p.status();
  } catch {
    return null;
  }
}

/**
 * Switch the background link on.
 *
 * Resolves with the status the service reports — which, immediately after a
 * start, is `enabled` with `running` still catching up: starting a foreground
 * service is asynchronous and the answer to "is it connected?" is a poll of
 * {@link shellLinkStatus}, not this return value.
 *
 * **A refused notification permission is not a failure here.** The service
 * still runs, the process still stays out of the freezer and the send queue
 * still drains in the background — there is simply nowhere for the alerts to
 * appear. Say that; do not refuse to enable the link over it.
 */
export async function enableShellLink(): Promise<ShellLinkStatus | null> {
  const p = plugin();
  if (!p) return null;
  // The SAVED (tailnet) address, never the LAN route in force: the service
  // outlives this page and the Wi-Fi it verified — the tailnet works anywhere,
  // and a LAN address is only ever dialled right after its MAC was checked.
  const base = savedHostBase();
  const url = wsUrlFor(base, "/ws");
  if (!url) return null; // No host paired — there is nothing to hold open.
  try { await p.requestNotifications(); } catch { /* refused; the link still runs */ }
  const label = base ? base.replace(/^https?:\/\//, "") : "host";
  return p.start({ url, protocol: PROTOCOL_VERSION, label });
}

/** Switch it off: the service stops, its notification goes, the periodic
 *  health check is cancelled and the boot receiver will not start it again. */
export async function disableShellLink(): Promise<void> {
  const p = plugin();
  if (!p) return;
  try { await p.stop(); } catch { /* already gone */ }
}

/** Send the user to the battery-optimisation exemption. Not only a battery
 *  question: an app the system may doze cannot start a foreground service from
 *  the background, which is what the boot receiver and the periodic health
 *  check do — so this is also what makes the recovery paths work. */
export async function requestShellBatteryExemption(): Promise<void> {
  const p = plugin();
  if (!p) return;
  try { await p.requestBatteryExemption(); } catch { /* no such screen */ }
}

/**
 * Ask for the notification permission, and where Android will no longer ask
 * (refused twice), open the app's notification settings instead — the only
 * place the switch can then be turned on. Resolves with whether it was granted
 * by the dialog; a trip to Settings is read back by the next status poll.
 */
export async function requestShellNotifications(): Promise<boolean> {
  const p = plugin();
  if (!p) return false;
  let granted = false;
  try { granted = (await p.requestNotifications()).granted; } catch { /* treated as refused */ }
  if (granted) return true;
  if (typeof p.openNotificationSettings === "function") {
    try { await p.openNotificationSettings(); } catch { /* no such screen */ }
  }
  return false;
}

/**
 * Tell the service how many sends are queued and undelivered.
 *
 * The service cannot see the queue — it is in localStorage and its upload bytes
 * are in IndexedDB — so this is the one number it is told, and it matters only
 * in the case the page cannot cover itself: **the app swiped away with prompts
 * still queued.** The prompts are safe either way; the count is what turns
 * "sits there until you next open the app" into "the phone tells you the moment
 * sending would work". Persisted natively, because the process death that lost
 * the page is exactly what it has to survive.
 *
 * Cheap enough to call on every outbox write — a no-op in the browser, and a
 * single SharedPreferences write in the shell — but it only reports CHANGES,
 * since an outbox write happens per keystroke-batch and this crosses a bridge.
 */
let lastDepth = -1;
export function reportShellQueueDepth(depth: number): void {
  const p = plugin();
  if (!p) return;
  const n = Math.max(0, Math.floor(depth));
  if (n === lastDepth) return;
  lastDepth = n;
  void p.setQueueDepth({ depth: n }).catch(() => { lastDepth = -1; });
}

// ── The two globals the shell calls ──────────────────────────────────────

/** Session ids the shell asked for before anything was listening. A cold start
 *  from a notification reaches native's first attempt long before React has
 *  mounted, and the shell retries — but holding the last one means the handler
 *  that registers a moment later still gets it. */
let pendingOpen: string | null = null;
const openHandlers = new Set<(sessionId: string) => void>();

/**
 * Register interest in "a tapped notification wants this session".
 *
 * Returns an unsubscribe. Registering also drains anything the shell delivered
 * before there was a listener, which is the normal case on a cold start.
 */
export function onShellOpenSession(fn: (sessionId: string) => void): () => void {
  openHandlers.add(fn);
  if (pendingOpen) {
    const id = pendingOpen;
    pendingOpen = null;
    fn(id);
  }
  return () => { openHandlers.delete(fn); };
}

/** A pairing deep link the shell handed over before anything was listening. */
let pendingPair: PairTarget | null = null;
const pairHandlers = new Set<(t: PairTarget) => void>();

/**
 * Register interest in "a pairing deep-link `…://pair` link arrived". The handler must only
 * OPEN the pair form, prefilled — any app can fire that link, so nothing is
 * redeemed until the person taps pair. Drains a link that came first.
 */
export function onShellPair(fn: (t: PairTarget) => void): () => void {
  pairHandlers.add(fn);
  if (pendingPair) {
    const t = pendingPair;
    pendingPair = null;
    fn(t);
  }
  return () => { pairHandlers.delete(fn); };
}

/**
 * Install the globals. Idempotent, and safe in a browser — where it simply
 * defines two functions nothing will ever call.
 *
 * Called once at boot (`main.tsx`). Deliberately not done on import so the
 * moment it happens is visible in one file, the way `installHostRouting` and
 * the traffic meter's transport patches are.
 */
export function installShellBridge(): void {
  defineShellGlobal("Nudge", (reason: string) => {
    try {
      window.dispatchEvent(new CustomEvent(SHELL_NUDGE_EVENT, { detail: { reason } }));
    } catch { /* a document being torn down */ }
  });
  // Returns whether anything took it. The shell retries on false, because on a
  // cold start it asks before the bundle has booted.
  defineShellGlobal("Open", (sessionId: string): boolean => {
    if (!sessionId) return true;
    try {
      window.dispatchEvent(new CustomEvent(SHELL_OPEN_EVENT, { detail: { sessionId } }));
    } catch { /* as above */ }
    if (openHandlers.size === 0) {
      pendingOpen = sessionId;
      return false;
    }
    for (const fn of openHandlers) fn(sessionId);
    return true;
  });
  // A pairing deep-link `…://pair?u=…&c=…` link. ALWAYS truthy once looked at — the shell
  // retries a falsy answer for 20 s, and a link held here (no listener yet) is
  // taken: the next `onShellPair` drains it. An invalid link is said once and
  // dropped; a valid one only ever opens the form (never a redeem).
  defineShellGlobal("Pair", (url: string): boolean => {
    const r = pairLinkRequest(url);
    if (r.kind === "invalid") { showToast(PAIR_LINK_INVALID); return true; }
    if (pairHandlers.size === 0) { pendingPair = r.target; return true; }
    for (const fn of pairHandlers) fn(r.target);
    return true;
  });
}
