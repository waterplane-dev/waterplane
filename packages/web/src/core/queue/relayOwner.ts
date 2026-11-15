/**
 * The relay OWNER seam: who may put the queue's frames on the wire while no
 * page can, and the gate that keeps the page's flusher off the wire until it
 * has taken the queue back. Plan: .claude/outbox/bg-link-send/PLAN.md.
 *
 * THE RELAY IS THE QUEUE'S OWN FRAMES, NOT A SEND PATH. An owner is handed the
 * pure `relayPlan` (shared) on every queue change, is told when the page is
 * going away (`release`), and on `claim` gives the queue back with what it did
 * — receipts (verbatim ack frames) and the ackIds it wrote. It never mints an
 * ackId and never edits a row: `wire.ts`'s `applyRelayClaim` replays the
 * receipts through the queue's own handlers.
 *
 * ONE interface, two implementations: the APK's `ShellLinkService`
 * (`shellLink.ts`'s `shellRelayOwner`) and the PWA service worker over
 * IndexedDB (`swRelayOwner.ts`, worker half `public/swRelay.js`) — `main.tsx`
 * installs whichever this document has, and nothing else in the queue changes.
 *
 * THE GATE. On cold boot, on `resume` and on `visibilitychange` → visible, the
 * page claims BEFORE its first flush: `relayHeld()` is true from that moment
 * until the claim has been applied, and `flushOutbox` and the reconnect drain
 * send nothing while it holds. A claim that throws is retried for up to
 * `CLAIM_GIVE_UP_MS`, then the gate opens anyway (a late answer is still
 * applied — receipts are by ackId, and a re-send of a written row joins or is
 * re-acked on the host). No owner installed (every browser today, an APK
 * without the `relay` cap) ⇒ the gate is never held: the queue behaves
 * exactly as it did before the relay existed.
 *
 * No DOM at import and no shell import, so node tests drive it (`relayClaim.test.mjs`).
 */
import type { RelayClaim, RelayPlan } from "@waterplane/shared";
import { createStore } from "../../sdk/store.ts";

/** A sender that can carry the queue while the page cannot. */
export interface RelayOwner {
  /** Which implementation — for logs and words, never for a branch in the queue. */
  readonly kind: "apk" | "sw";
  /** Does this owner really carry the relay (a capability check, asked once)? False ⇒ uninstalled. */
  available(): Promise<boolean>;
  /** The latest plan, replacing the last. Cheap to call on every queue write: the owner sends only a change. */
  hand(plan: RelayPlan): void;
  /** The page is going away: the owner may send once the app is hidden. Fire and forget. */
  release(): void;
  /** Ownership back to the page, and what the owner did since it last answered. Rejects when it cannot say. */
  claim(): Promise<RelayClaim>;
  /** The desktop the plan is for where the page has no saved host (a browser is served BY its desktop). */
  hostId?(): string | null;
}

/** How long a failing claim is retried before the page flushes anyway. */
export const CLAIM_GIVE_UP_MS = 10_000;
/** Between two claim attempts. */
export const CLAIM_RETRY_MS = 1_000;

/** True while the page is taking the queue back — the flusher's gate, as a store for the drain effect. */
export const relayHeldStore = createStore<boolean>(false);

interface Timers { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void }

let owner: RelayOwner | null = null;
let confirmed = false;
let build: (() => RelayPlan | null) | null = null;
let applier: ((c: RelayClaim) => void) | null = null;
let parked: RelayClaim[] = [];
const opened = new Set<() => void>();
let claimSeq = 0;
let timers: Timers = { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id as number) };

function setHeld(v: boolean): void {
  if (relayHeldStore.get() !== v) relayHeldStore.set(v);
}

/** Is the page's flusher held off the wire while it takes the queue back? */
export function relayHeld(): boolean {
  return relayHeldStore.get();
}

/**
 * Install the owner (once, at boot, before anything flushes). Holds the gate at
 * once and starts the boot claim; an owner that turns out not to carry the relay
 * is dropped and the gate opens. `null` (or never called) = no relay.
 */
export function installRelayOwner(o: RelayOwner | null, t?: Timers): void {
  if (t) timers = t;
  owner = o;
  confirmed = false;
  claimDeferred = false;
  if (!o) { setHeld(false); return; }
  setHeld(true);
  void o.available().then((ok) => {
    if (owner !== o) return;
    if (!ok) { owner = null; open(); return; }
    confirmed = true;
    publishNow();
  }, () => { if (owner === o) { owner = null; open(); } });
  startClaim();
}

/** The owner's own name for this page's desktop (`RelayOwner.hostId`), or null. */
export function relayOwnerHostId(): string | null {
  return owner?.hostId?.() ?? null;
}

/** The queue's plan builder (`useQueue`): called on every write, and once more before a release. */
export function publishRelayPlan(fn: () => RelayPlan | null): void {
  build = fn;
  publishNow();
}

/** Hand the freshest plan now, whatever wrote or did not write the queue: a preference, the budget
 *  or the session list changed, or the page is going to the background (`installRelayLifecycle`). */
export function republishRelayPlan(): void {
  publishNow();
}

function publishNow(): void {
  if (!owner || !confirmed || !build) return;
  const plan = build();
  if (plan) owner.hand(plan);
}

/** The page is freezing (`ws.ts`'s `freeze` handler): hand the freshest plan, then let go. */
export function releaseRelay(): void {
  if (!owner || !confirmed) return;
  publishNow();
  owner.release();
}

/** Start taking the queue back (`resume`, visible). A claim already holding the gate is joined. */
export function reclaimRelay(): void {
  if (!owner || relayHeld()) return;
  setHeld(true);
  startClaim();
}

/** The queue registers what a claim does to its rows (`wire.ts`'s `applyRelayClaim`).
 *  A claim answered before it registered (a cold boot) is applied now, and the gate opens. */
export function onRelayClaim(fn: ((c: RelayClaim) => void) | null): void {
  applier = fn;
  if (!fn) return;
  const late = parked;
  parked = [];
  for (const c of late) fn(c);
  if (claimDeferred) { claimDeferred = false; startClaim(); return; }
  if (awaitingApplier) { awaitingApplier = false; open(); }
}

/** Run once the gate opens (flush, and the drain the gate deferred). Returns the remover. */
export function onRelayOpen(fn: () => void): () => void {
  opened.add(fn);
  return () => { opened.delete(fn); };
}

/** May the gate opening flush at once? Not while the reconnect drain has yet to run for this open
 *  link (it has not seen `open`, or it deferred itself behind the gate): the drain asks the
 *  reconnect question first, then flushes — a flush here would type the offline rows unasked. */
export function relayOpenFlushes(drainSeen: string | null, drainDeferred: boolean): boolean {
  return drainSeen === "open" && !drainDeferred;
}

function open(): void {
  if (!relayHeld()) return;
  setHeld(false);
  for (const fn of [...opened]) { try { fn(); } catch { /* one listener's throw never strands the rest */ } }
}

let awaitingApplier = false;
/** A claim wanted while no queue is mounted to apply it (boot, a sealed sign-in still waiting). */
let claimDeferred = false;
function startClaim(): void {
  const o = owner;
  if (!o) return;
  // A claim EMPTIES the owner's store (receipts, written) before the page has applied anything:
  // asked with nobody to apply the answer, a page that dies first loses what the relay did and
  // the plan's rows would be sent again. So it is asked only once the queue has registered.
  if (!applier) { claimDeferred = true; return; }
  const seq = ++claimSeq;
  const startedAt = Date.now();
  // A claim that never answers (a hung bridge) must not hold the queue for ever.
  const giveUp = timers.setTimeout(() => { if (seq === claimSeq) open(); }, CLAIM_GIVE_UP_MS);
  const attempt = (): void => {
    o.claim().then((c) => {
      timers.clearTimeout(giveUp);
      // Applied even when late: receipts are by ackId and a written row is never re-decided.
      if (applier) applier(c);
      else if (c.receipts.length || c.written.length) parked.push(c);
      if (seq !== claimSeq) return; // a later claim holds the gate; it opens when that one lands
      if (applier) open(); else awaitingApplier = true;
    }, () => {
      if (seq !== claimSeq) return;
      if (Date.now() - startedAt + CLAIM_RETRY_MS >= CLAIM_GIVE_UP_MS) return; // the give-up timer opens
      timers.setTimeout(attempt, CLAIM_RETRY_MS);
    });
  };
  attempt();
}

/** Page lifecycle wiring (`main.tsx`, after `installRelayOwner`): claim on resume and on visible;
 *  on hidden, hand the freshest plan while the page still runs — the page may be killed from there
 *  with no `freeze`, and the relay then sends from whatever was handed last. */
export function installRelayLifecycle(): void {
  if (typeof document === "undefined") return;
  document.addEventListener("resume", reclaimRelay);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reclaimRelay();
    else if (document.visibilityState === "hidden") republishRelayPlan();
  });
}

/** Tests only: back to the boot state. */
export function resetRelayForTest(): void {
  owner = null; confirmed = false; build = null; applier = null; parked = []; opened.clear(); claimSeq = 0; awaitingApplier = false; claimDeferred = false;
  relayHeldStore.set(false);
}
