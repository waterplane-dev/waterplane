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
 *   - on a session WITH a companion → Claude lit, Shell attaches the newest.
 * Anything else has no pair, and the tabs are ABSENT: a session with no
 * companion yet (the owner's ask, 2026-10-07: the tabs appear once the
 * burger's "companion shell" made one, never as a standing "open a shell"
 * offer), a plain shell, a pending open, a parent that is gone.
 */
import { companionToggle } from "@waterplane/shared";

export type PairTabs<T> =
  | { on: "cli"; shell: T }
  | { on: "shell"; cli: T };

export function pairTabs<T extends { id: string; companionOf?: string; createdAt?: number }>(
  active: T,
  sessions: readonly T[],
  can: { pending: boolean },
): PairTabs<T> | null {
  if (can.pending) return null;
  const pair = companionToggle(active, sessions);
  if (pair?.to === "cli") return { on: "shell", cli: pair.target };
  if (pair?.to === "shell") return { on: "cli", shell: pair.target };
  return null;
}

/**
 * One segment of the session header's segment (`SessionHeader`'s `SessionSegs`): the session's
 * own tab, its pair's other half, or a contributed VIEW (`SessionViewDef`, the live desktop).
 * `on` is where you are — drawn as a label, not a button.
 */
export type SessionSeg<T, V> =
  | { kind: "cli" | "shell"; on: true }
  | { kind: "cli" | "shell"; on: false; target: T }
  | { kind: "view"; view: V };

/**
 * The whole segment, generalised from `pairTabs`:
 *   - no view contributed ⇒ EXACTLY `pairTabs` (null with no companion, the two tabs with one) —
 *     the header with no extension is the header it always was (R-shell-009);
 *   - a companion pair ⇒ its two tabs, then every view;
 *   - no pair but a view ⇒ the session's own tab lit (`Shell` for a shell — `can.shell`, or an
 *     orphaned companion — else the agent), then every view: `[Claude | Desktop]`, `[Shell | Desktop]`.
 * A pending open has no segment at all: there is no session yet for a view to sit beside.
 */
export function sessionSegs<T extends { id: string; companionOf?: string; createdAt?: number }, V>(
  active: T,
  sessions: readonly T[],
  can: { pending: boolean; shell: boolean },
  views: readonly V[],
): SessionSeg<T, V>[] | null {
  if (can.pending) return null;
  const pair = pairTabs(active, sessions, can);
  let base: SessionSeg<T, V>[];
  if (pair?.on === "cli") base = [{ kind: "cli", on: true }, { kind: "shell", on: false, target: pair.shell }];
  else if (pair?.on === "shell") base = [{ kind: "cli", on: false, target: pair.cli }, { kind: "shell", on: true }];
  else if (!views.length) return null;
  else base = [{ kind: can.shell || active.companionOf ? "shell" : "cli", on: true }];
  return [...base, ...views.map((view) => ({ kind: "view" as const, view }))];
}
