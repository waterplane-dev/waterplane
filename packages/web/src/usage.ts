/**
 * Feature-usage tracking for the whole UI.
 *
 * `track("toolbar:diff")` at every feature entry point. Counts land in
 * localStorage IMMEDIATELY (so "sort the toolbar by most-used" is instant and
 * works offline) and are flushed as deltas to the host, which merges them into
 * <STATE_DIR>/ui-usage.json — the file to point a coding agent at when asking
 * "what do I actually use? delete the rest".
 *
 * Id convention (keep it greppable — an agent maps ids back to code):
 *   toolbar:<id>   a terminal-toolbar action
 *   overlay:<name> a sheet/overlay was opened
 *   action:<name>  anything else (compose send, voice, fork, git commit, …)
 *
 * Flush policy: batched (FLUSH_MS) + on hide/pagehide via sendBeacon, because a
 * phone is usually backgrounded, not closed. Failures are swallowed and the
 * delta is put back — telemetry must never surface an error to the user.
 */
import type { UiUsageDoc } from "@waterplane/shared";
import { LS, lsGet, lsSetJson } from "./storage";
import { api } from "./api";

const LS_KEY = LS.usage;
const FLUSH_MS = 20000;

export interface LocalStat { count: number; last: number }
type Counts = Record<string, LocalStat>;

function load(): Counts {
  try {
    const raw = JSON.parse(lsGet(LS_KEY) || "{}");
    return raw && typeof raw === "object" ? (raw as Counts) : {};
  } catch { return {}; }
}

let counts: Counts = load();
let pending: Record<string, number> = {};
let timer: number | null = null;
const subs = new Set<() => void>();

function save(): void {
  lsSetJson(LS_KEY, counts);
}

/** Record one use of a feature. Cheap: a local bump plus a queued delta. */
export function track(id: string): void {
  if (!id) return;
  const e = counts[id];
  if (e) { e.count++; e.last = Date.now(); }
  else counts[id] = { count: 1, last: Date.now() };
  pending[id] = (pending[id] || 0) + 1;
  save();
  for (const fn of subs) fn();
  if (timer === null) timer = window.setTimeout(() => { timer = null; void flushUsage(); }, FLUSH_MS);
}

/** This device's count for one feature id (0 if never used). */
export function usageCount(id: string): number { return counts[id]?.count ?? 0; }

/** This device's whole local table (used for frequency sorting). */
export function localUsage(): Counts { return counts; }

/** Push queued deltas to the host. `beacon` for the page-hide path. */
export function flushUsage(beacon = false): void {
  const batch = pending;
  if (!Object.keys(batch).length) return;
  pending = {};
  const body = JSON.stringify({ counts: batch });
  if (beacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
    // Blob with an explicit type: a bare string beacon posts as text/plain.
    const ok = navigator.sendBeacon("/api/ui-usage", new Blob([body], { type: "application/json" }));
    if (!ok) requeue(batch);
    return;
  }
  api.uiUsage.flush(body).catch(() => requeue(batch));
}

function requeue(batch: Record<string, number>): void {
  for (const [id, n] of Object.entries(batch)) pending[id] = (pending[id] || 0) + n;
}

/** Host-side aggregate (all devices) for the Settings viewer. */
export async function fetchUsage(): Promise<UiUsageDoc | null> {
  return api.uiUsage.get();
}

/** Reset both the host document and this device's local counters. */
export async function resetUsage(): Promise<void> {
  counts = {};
  pending = {};
  save();
  for (const fn of subs) fn();
  await api.uiUsage.reset();
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushUsage(true); });
}
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => flushUsage(true));
}
