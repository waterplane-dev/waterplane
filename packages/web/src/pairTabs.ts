/**
 * The session header's two tabs, `[Claude | Shell]`: which half of a CLI ↔
 * companion-shell pair is on screen, and what a tap on the OTHER half does.
 *
 * It replaced the orange `shell` / `CLI` button in the terminal's corner group
 * (the owner's ask: two tabs up in the header, the one you are on lit, one tap
 * either way). A tab says where you ARE as well as where a tap goes, which the
 * single toggle never did — it named only the destination.
 *
 * Pure so the three shapes are decided once and node-tested:
 *   - on a companion shell → Shell lit, Claude attaches the parent;
 *   - on a session WITH a companion → Claude lit, Shell attaches the newest;
 *   - on a session without one → Claude lit, Shell OPENS one (the burger's
 *     "companion shell", the same create path) — only where the host can.
 * Anything else (a plain shell, a pending open, a parent that is gone) has no
 * pair, and the tabs are ABSENT rather than a half that does nothing.
 */
import { companionToggle } from "@waterplane/shared";

export type PairTabs<T> =
  | { on: "cli"; shell: { attach: T } | "open" }
  | { on: "shell"; cli: T };

export function pairTabs<T extends { id: string; companionOf?: string; createdAt?: number }>(
  active: T,
  sessions: readonly T[],
  can: { pending: boolean; isShell: boolean; canOpenShell: boolean },
): PairTabs<T> | null {
  if (can.pending) return null;
  const pair = companionToggle(active, sessions);
  if (pair?.to === "cli") return { on: "shell", cli: pair.target };
  if (pair?.to === "shell") return { on: "cli", shell: { attach: pair.target } };
  if (can.isShell || !can.canOpenShell) return null;
  return { on: "cli", shell: "open" };
}
