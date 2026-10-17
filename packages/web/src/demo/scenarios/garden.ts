/**
 * The fictional desktop every scenario shares (demo-mode-plan.md §3): the same
 * three repos, so `first-look`, `queue-and-schedule`, `gallery-and-files` and
 * `numbers` read as one machine seen four ways. Nothing here is from a real
 * disk; `scenarios.test.mjs` runs the recording tool's scrub over each result.
 *
 * `first-look.ts` predates this file and keeps its own copies of these
 * constants; the values are the same (the repo ids `r1..r3` are what
 * `public/demo/media/<repoId>/` is keyed by).
 */
import type { DemoModel } from "../host/model.ts";
import { demoRepoHealthIndex } from "../host/healthindex.ts";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const GARDEN = "~/dev/todo-garden";
export const NOTES = "~/dev/pocket-notes";
export const TRAIL = "~/dev/trail-log";

const enc = new TextEncoder();
/** A session's retained PTY tail; `seq` counts its bytes. */
export const screen = (data: string, cols = 80, rows = 24) => ({ data, seq: enc.encode(data).length, cols, rows });

export const B = "\x1b[1m";
export const D = "\x1b[2m";
export const G = "\x1b[32m";
export const R0 = "\x1b[0m";
export const bullet = (t: string) => `● ${t}\r\n`;
export const tool = (name: string, arg: string, res: string) => `${B}● ${name}${R0}(${arg})\r\n${D}  ⎿  ${res}${R0}\r\n`;

/** The three repos; `outbox`/`changed` differ per scenario. */
export function repos(o: { outbox?: Partial<Record<"r1" | "r2" | "r3", number>>; healthIndex?: number } = {}): NonNullable<DemoModel["repos"]> {
  const n = (id: "r1" | "r2" | "r3") => o.outbox?.[id] ?? 0;
  // `healthIndex: <now>` = the scenarios that serve the repo-health routes also send the health score
  // (`demo/host/healthindex.ts`), so the launcher chip appears; trail-log has none, to show the absent case.
  const hi = (name: string) => (o.healthIndex ? { healthIndex: demoRepoHealthIndex(name, o.healthIndex) } : {});
  return [
    { id: "r1", repoName: "todo-garden", branch: "main", isPrimary: true, worktreePath: GARDEN, outboxCount: n("r1"), changedCount: 2, hasRepoHealth: true, ...hi("todo-garden") },
    { id: "r2", repoName: "pocket-notes", branch: "main", isPrimary: true, worktreePath: NOTES, outboxCount: n("r2"), changedCount: 0, hasRepoHealth: true, ...hi("pocket-notes") },
    { id: "r3", repoName: "trail-log", branch: "main", isPrimary: true, worktreePath: TRAIL, outboxCount: n("r3"), changedCount: 1, hasRepoHealth: true },
  ];
}

/** The next Monday 09:00 Berlin (07:00 UTC in summer time, close enough for a seeded row), after `now`. */
export function nextMonday(now: number): number {
  const d = new Date(now);
  const add = (8 - d.getUTCDay()) % 7 || 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + add, 7, 0, 0);
}
