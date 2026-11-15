/**
 * The PWA's `RelayOwner` (`relayOwner.ts`): the service worker carries the queue's frames while
 * no page can (plan: .claude/outbox/bg-link-send/PLAN.md, WP8). The worker half is
 * `public/swRelay.js`; the store between them is IndexedDB `relay` (idb.ts v17, mutations in
 * `swRelayStore.ts`).
 *
 * Browser only: never in the Android shell (it has the APK owner and no service worker), never
 * in the demo, never where the worker is not registered (`main.tsx`'s rule: a secure context
 * served from the origin root).
 *
 *  - `hand` writes the plan on a change (`relayPlanKey`), the bearer beside it — or none when
 *    sign-ins are sealed — and asks for a Background Sync (Chromium) when the link is down.
 *  - `release` (`freeze`, and `pagehide` here) lets the worker own the queue; a page that has
 *    not beaten for 150 s is taken for gone too (the worker's `swOwns`).
 *  - `claim` reads and clears what the worker earned and takes ownership back, in ONE
 *    transaction. A store that cannot be read answers an empty claim: nothing was cleared, so
 *    the next claim still finds it, and a re-send of a written row joins or is re-acked.
 */
import { defaultHostName, relayPlanKey, type RelayClaim, type RelayPlan } from "@waterplane/shared";
import { idbUpdate } from "../../idb.ts";
import { DEVICE_TOKEN_EVENT, deviceToken, sealedMode } from "../../deviceToken.ts";
import { isNativeShell } from "../../hostUrl.ts";
import { isDemo } from "../../demo/mode.ts";
import { linkOnline } from "../../link/linkStatus.ts";
import { releaseRelay, type RelayOwner } from "./relayOwner.ts";
import {
  CLAIM_KEYS, OWN_KEYS, RELAY_STORE,
  claimMutation, handMutation, heartbeatMutation, planHasItems, releaseMutation,
} from "./swRelayStore.ts";

/** How often a running page says it is alive (the worker waits 150 s past the last). */
const HEARTBEAT_MS = 30_000;

/** Ask the worker for a Background Sync wake ("queue"). Chromium only; elsewhere nothing. */
function registerSync(): void {
  try {
    if (!("SyncManager" in window)) return;
    void navigator.serviceWorker.ready
      .then((r) => (r as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }).sync?.register("queue"))
      .catch(() => { /* refused (permission, no worker yet): the page sends it when it opens */ });
  } catch { /* no worker */ }
}

/** The PWA owner, or null where there is no worker to carry it. */
export function swRelayOwner(): RelayOwner | null {
  if (typeof window === "undefined" || typeof navigator === "undefined") return null;
  if (isNativeShell() || isDemo()) return null;
  if (!("serviceWorker" in navigator) || typeof indexedDB === "undefined" || !window.isSecureContext) return null;
  if (import.meta.env.BASE_URL !== "/") return null;

  // The browser has no saved-host list: the page IS served by its desktop, so the origin names it.
  const hostId = `origin:${location.origin}`;
  const label = defaultHostName(location.origin);
  let lastKey: string | null = null;
  let lastPlan: RelayPlan | null = null;

  const write = (plan: RelayPlan): void => {
    const sealed = sealedMode();
    const tok = sealed ? null : deviceToken();
    void idbUpdate(RELAY_STORE, [], handMutation(plan, { hostId, label, sealed, ...(tok ? { token: tok } : {}) }))
      .then((ok) => { if (ok === null) lastKey = null; });
  };

  const beat = (): void => { void idbUpdate(RELAY_STORE, OWN_KEYS, heartbeatMutation(Date.now())); };
  setInterval(beat, HEARTBEAT_MS);
  window.addEventListener("pagehide", releaseRelay);
  // A re-minted or dropped token re-hands the plan with the bearer it now has.
  window.addEventListener(DEVICE_TOKEN_EVENT, () => { if (lastPlan) write(lastPlan); });

  return {
    kind: "sw",
    hostId: () => hostId,
    available: async () => true,
    hand(plan: RelayPlan): void {
      const key = `${relayPlanKey(plan)}|${sealedMode() ? "s" : "o"}`;
      if (key === lastKey) return;
      lastKey = key;
      lastPlan = plan;
      write(plan);
      if (planHasItems(plan) && !linkOnline()) registerSync();
    },
    release(): void {
      void idbUpdate(RELAY_STORE, OWN_KEYS, releaseMutation(Date.now()));
      if (planHasItems(lastPlan)) registerSync();
    },
    async claim(): Promise<RelayClaim> {
      const c = await idbUpdate(RELAY_STORE, CLAIM_KEYS, claimMutation(Date.now()));
      return c ?? { receipts: [], written: [] };
    },
  };
}

