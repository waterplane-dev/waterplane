import { nativePullSupported, nativeSetAuto, onNativePullChange } from "../nativePull";
import { noNetwork, pumpEligible, strandedDownload } from "../downloadState";
import { linkOnline } from "../link";
import type { PullRecord } from "./pullTypes";
import { STALL_MS, MAX_ATTEMPTS, BACKOFF, TICK_MS, autoPull } from "./pullConsts";
import type { PullManager } from "./pullManager";

// ── the pump ──────────────────────────────────────────────────────
/** Start the manager: wire the wake-ups that decide when to try again. */
export function pullStart(this: PullManager): void {
  if (this.started) return;
  this.started = true;
  // The shell's copy of the switch: the link service reads it while this
  // document is frozen. Re-stated every boot, so a value that changed by any
  // other route (a synced setting, a cleared store) cannot drift for long.
  void nativeSetAuto(autoPull());
  // A record left `downloading` by a page that was killed mid-transfer: the
  // engine lives in the page, so nothing is moving it, and `pump` only ever
  // picks `queued` — it would show a spinner forever. Reviving it here is what
  // makes "the OS killed the app at 60%" resumable instead of terminal.
  // A record the browser was carrying (`engine: "bgfetch"`) is a separate
  // case: nothing in THIS page killed it, so if no live fetch turns up and no
  // verdict was parked for it, that transfer ended while the app was shut and
  // nobody counted it. `recoverBackgroundFetches` charges those, because a
  // silently revived record re-registers the same failing fetch for ever.
  const orphans: string[] = [];
  for (const r of this.list()) {
    if (r.state !== "downloading") continue;
    // A NATIVE transfer is not orphaned by the page dying — the service is
    // very likely still moving those bytes. Re-queueing it here would start a
    // second copy of a live download; `syncNative` below says what actually
    // became of it.
    if (r.engine === "native" && nativePullSupported()) continue;
    if (r.engine === "bgfetch") orphans.push(r.item.id);
    this.patch(r.item.id, { state: "queued", rate: undefined });
  }
  addEventListener("online", () => this.pump());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) this.pump(); });
  // A wake is the moment a frozen transfer has to be re-judged, and `pageshow`
  // fires for a bfcache restore where `visibilitychange` does not.
  addEventListener("pageshow", () => this.pump());
  setInterval(() => this.pump(), TICK_MS);
  // Live progress while the page is awake. It is never the only source — see
  // `syncNative` — but without it a visible transfer would only move every
  // heartbeat.
  onNativePullChange((rows) => { void this.syncNative({ items: rows, running: true }); });
  void this.syncNative();
  void this.recoverBackgroundFetches(orphans).then(() => this.evictOld());
  this.pump();
}

/**
 * Run the next eligible download. `force` bypasses the auto-download switch —
 * that is a user tap, which is always allowed.
 *
 * Nothing here is a loop: each finished transfer calls back into `pump`, so a
 * failure that immediately re-queues can't spin.
 */
export function pullPump(this: PullManager, force = false, preferId?: string): void {
  this.syncNativeSoon();
  this.watchdog();
  if (this.active) return;
  // `navigator.onLine` is not evidence: a phone on 5G is "online" while the
  // Tailscale path is dead, and a WebView can report the opposite — which it
  // does, stuck at `false` with the socket open, and this gate then held the
  // whole queue at "waiting to start" over a link that was measurably fine
  // (`noNetwork`). It gates the automatic path only — a tap always gets a
  // real attempt, and the header/stall fuses below are what actually decide
  // the link is gone.
  if (!force && noNetwork(navigator.onLine, linkOnline())) return;
  // Which rows may run — including the rule that a tapped (`local`) row is not
  // governed by the auto-download switch. `downloadState.ts`, so it is pinned.
  const auto = autoPull();
  const now = Date.now();
  const eligible = (r: PullRecord | undefined) => pumpEligible(r, { auto, force, maxAttempts: MAX_ATTEMPTS, now });
  const preferred = preferId ? this.records[preferId] : undefined;
  const next = eligible(preferred) ? preferred : this.list().find((r) => eligible(r));
  if (!next) return;
  this.active = next.item.id;
  void this.run(next.item.id).finally(() => {
    this.active = null;
    // Only chain automatically; a forced single download shouldn't drag the
    // whole queue along behind an auto-download switch that is off — but a
    // file a person tapped is not automatic work, so a queue of those drains
    // whatever the switch says.
    if (autoPull() || this.list().some((r) => r.local && r.state === "queued")) this.pump();
  });
}

/**
 * The transfer we believe is running has gone quiet for far longer than the
 * stall fuse allows. That fuse is a `setTimeout`, and a FROZEN page (Android
 * backgrounding the WebView, a phone in a pocket) freezes it too — so on wake
 * it can be minutes late, and until it fires `active` is pinned and the whole
 * queue is stopped with a spinner on screen. Aborting here is what turns that
 * back into an ordinary retry.
 */
export function pullWatchdog(this: PullManager): void {
  // Runtime unstranding, the twin of the sweep `start()` does at boot.
  // Without it, losing a carrier mid-life left the row unrunnable until the
  // next page load: `pumpEligible` takes only `queued`, and the loop below
  // returns immediately when there is no `active` to watch. A Background
  // Fetch is left alone — the browser is very likely still carrying it, and
  // `recoverBackgroundFetches` charges the ones that died while we were shut.
  for (const r of this.list()) {
    if (!strandedDownload(r, { activeId: this.active, nativeSupported: nativePullSupported() })) continue;
    this.patch(r.item.id, { state: "queued", rate: undefined });
  }
  const id = this.active;
  if (!id) return;
  const r = this.records[id];
  if (!r || r.state !== "downloading") return;
  if (r.engine === "bgfetch") return;               // the browser owns it; it has its own retries
  // Same rule for the native engine, and it matters more: this page's clock
  // stopped while the app was backgrounded, so "no progress for a minute" is
  // a statement about the page, not about the transfer. The service has its
  // own read timeout and its own backoff.
  if (r.engine === "native") return;
  if (Date.now() - (r.lastProgressAt ?? r.updatedAt) < STALL_MS * 2) return;
  this.abort?.abort();
  // The abort lands asynchronously (the fetch rejects, `run` requeues, only
  // then is the slot free). Come back for it rather than making the user wait
  // out a whole heartbeat for the retry they just asked for.
  setTimeout(() => this.pump(), 250);
}

export async function pullRun(this: PullManager, id: string): Promise<void> {
  const rec = this.records[id];
  if (!rec) return;
  const before = rec.received;
  this.patch(id, { state: "downloading", error: undefined, nextRetryAt: undefined, lastProgressAt: Date.now() });
  const bg = await this.startBackgroundFetch(rec);
  if (bg) return; // the browser owns it now; the SW reports completion
  const native = await this.startNative(rec);
  if (native) return; // the service owns it now; `syncNative` reads the verdict
  try {
    await this.rangeFetch(id);
  } catch (e) {
    const err = e as Error & { permanent?: boolean };
    const msg = err?.name === "AbortError" ? "connection stalled" : String(err?.message || e);
    const cur = this.records[id];
    if (!cur) return;                      // removed or superseded under us
    if (cur.state === "paused") return;    // a user pause aborts the fetch; that is not a failure
    // Progress resets the attempt count. A link handing over 40 KB per try is
    // awful, but it IS finishing the file — only an attempt that moved nothing
    // is evidence of a link worth giving up on.
    const progressed = cur.received > before;
    const attempts = progressed ? 0 : (cur.attempts ?? 0) + 1;
    const failed = !!err?.permanent || attempts >= MAX_ATTEMPTS;
    this.patch(id, { state: failed ? "failed" : "queued", attempts, error: msg, rate: undefined });
    if (!failed) this.scheduleRetry(id, attempts);
  }
}

export function pullScheduleRetry(this: PullManager, id: string, attempts: number): void {
  if (this.retryTimer) clearTimeout(this.retryTimer);
  const wait = BACKOFF[Math.min(Math.max(1, attempts) - 1, BACKOFF.length - 1)];
  this.patch(id, { nextRetryAt: Date.now() + wait });
  this.retryTimer = setTimeout(() => { this.retryTimer = null; this.pump(); }, wait) as unknown as number;
}
