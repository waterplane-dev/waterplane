/**
 * The low-disk push: one `disk` notification when the home volume drops under
 * the line (`WATERPLANE_DISK_WARN_GB`, default 10 GB free), and one more under
 * `DISK_CRITICAL_GB`.
 *
 * Why it exists (2026-10-21): with 7.5 GB free, macOS's `cache_delete` ended
 * Tailscale's app and network extension to empty their caches — six times in
 * twenty minutes. Connect-on-demand restarted the extension within seconds,
 * except once, when the app went too and nothing brought it back: the phone lost
 * the desktop with no word about why. The OS gives no way to exempt an app, so
 * the defence is to be told before the volume gets there.
 *
 *  - **Once per level crossed.** Re-armed only when free space is back
 *    `DISK_REARM_GB` above the line, so a volume hovering at the line is one
 *    push, not one per check. Memory only: a restart may say it again while the
 *    disk is still low, which is a reminder, not a lie.
 *  - **Words only.** Nothing is deleted; the person decides what goes.
 *  - **A failed read is silence**, never a 0-byte disk.
 *  - Pure decision (`diskStep`) apart from the plumbing, like `agentwatch.ts`.
 */
import { statfs } from "node:fs/promises";
import os from "node:os";
import { envName, type NotificationKind } from "@waterplane/shared";

export type DiskLevel = "ok" | "low" | "critical";

export const DISK_WARN_GB_DEFAULT = 10;
export const DISK_CRITICAL_GB = 3;
/** How far back above a line free space must climb before it can warn again. */
export const DISK_REARM_GB = 2;
const GB = 1e9;
const RANK: Record<DiskLevel, number> = { ok: 0, low: 1, critical: 2 };

/** The line off its env string: a positive number of GB, `0` off (null), else the default. */
export function diskWarnGb(raw: string | undefined): number | null {
  const v = (raw ?? "").trim();
  if (v === "") return DISK_WARN_GB_DEFAULT;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return DISK_WARN_GB_DEFAULT;
  return n === 0 ? null : n;
}

export function diskLevel(availBytes: number, warnGb: number): DiskLevel {
  if (availBytes < Math.min(DISK_CRITICAL_GB, warnGb) * GB) return "critical";
  return availBytes < warnGb * GB ? "low" : "ok";
}

/**
 * One reading against what was last said: the level to push now (or null) and
 * the level now counted as said. Climbing back `DISK_REARM_GB` past a line
 * forgets that line, so the next drop through it is told again.
 */
export function diskStep(told: DiskLevel, availBytes: number, warnGb: number): { push: DiskLevel | null; told: DiskLevel } {
  const now = diskLevel(availBytes, warnGb);
  if (RANK[now] > RANK[told]) return { push: now, told: now };
  let next = told;
  if (next === "critical" && availBytes >= (Math.min(DISK_CRITICAL_GB, warnGb) + DISK_REARM_GB) * GB) next = "low";
  if (next === "low" && availBytes >= (warnGb + DISK_REARM_GB) * GB) next = "ok";
  return { push: null, told: next };
}

const gb = (b: number) => (b / GB >= 10 ? Math.round(b / GB).toString() : (b / GB).toFixed(1));

/** The push, in words. The macOS sentence only where it is true. */
export function diskPushText(level: DiskLevel, availBytes: number, totalBytes: number, platform: string): { title: string; body: string } {
  const title = `${level === "critical" ? "Desktop disk nearly full" : "Desktop disk low"} · ${gb(availBytes)} GB free`;
  const why = platform === "darwin"
    ? "macOS now ends apps to clear their caches — Tailscale among them, which cuts this phone off from the desktop."
    : "Builds, logs and sessions start failing when it runs out.";
  return { title, body: `${gb(availBytes)} of ${gb(totalBytes)} GB free on the desktop's home volume. ${why} Free some space on the desktop.` };
}

export interface DiskWatchDeps {
  notify(kind: NotificationKind, p: { title: string; body: string; tag?: string }): void;
  /** The home volume's free and total bytes, or null when it did not answer. */
  read?(): Promise<{ availBytes: number; totalBytes: number } | null>;
  warnGb?: number | null;
  everyMs?: number;
}

async function readHome(): Promise<{ availBytes: number; totalBytes: number } | null> {
  try {
    const fs = await statfs(os.homedir());
    const totalBytes = fs.blocks * fs.bsize;
    return totalBytes > 0 ? { availBytes: fs.bavail * fs.bsize, totalBytes } : null;
  } catch {
    return null;
  }
}

/** Start watching; returns the stop. `WATERPLANE_DISK_WARN_GB=0` starts nothing. */
export function startDiskWatch(deps: DiskWatchDeps): () => void {
  const warnGb = deps.warnGb !== undefined ? deps.warnGb : diskWarnGb(process.env[envName("DISK_WARN_GB")]);
  if (warnGb === null) return () => {};
  const read = deps.read ?? readHome;
  let told: DiskLevel = "ok";
  let busy = false;
  const check = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await read();
      if (!r) return;
      const step = diskStep(told, r.availBytes, warnGb);
      told = step.told;
      if (step.push) deps.notify("disk", { ...diskPushText(step.push, r.availBytes, r.totalBytes, process.platform), tag: "disk" });
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(() => { void check(); }, 30_000);
  const timer = setInterval(() => { void check(); }, deps.everyMs ?? 5 * 60_000);
  first.unref?.();
  timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
