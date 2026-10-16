/**
 * The code folder as `GET /api/host/root` reports it, and what `POST` answers — the phone's
 * one-time "which folder holds your repos?" dialog and its Settings row (host: `rootchoice.ts`).
 */

/** How the running root came about: the knob, the person's choice, an existing usual folder, or `~/dev` assumed. */
export type RootPicked = "named" | "chosen" | "found" | "fallback";

export interface RootFolder {
  path: string;
  /** Repos (checkouts and worktrees) a scan finds under it. */
  repos: number;
}

export interface RootInfo {
  ok: true;
  /** The folder the running host scans. */
  root: string;
  picked: RootPicked;
  rootExists: boolean;
  repos: number;
  /** A folder saved but not yet in use — the host was started by hand and has not been restarted. */
  pending: string | null;
  /** Where a chosen folder is kept, to name in Settings ("change it here later"). */
  choicePath: string;
  /** The environment variable that overrides the choice, e.g. `WATERPLANE_ROOT`. */
  envName: string;
  /** This connection may change it (loopback + Tailscale, never LAN). */
  canChange: boolean;
  /** After a save: `auto` — the host restarts itself under launchd/systemd; `manual` — someone restarts it. */
  restart: "auto" | "manual";
  /** The usual code folders that exist on this desktop, with their repo counts. */
  candidates: RootFolder[];
}

/** `POST /api/host/root` `{ path, save }`: a check answers the folder and its count; a save also says how it takes effect. */
export type RootPostReply =
  | { ok: true; root: string; repos: number; saved?: false }
  | { ok: true; root: string; repos: number; saved: true; restart: "auto" | "manual" | "none" }
  | { ok: false; error: string };

/**
 * Whether the first-start dialog should ask: the folder was guessed (not named, not chosen),
 * or a chosen one has since disappeared. A named root never asks — whoever set the variable meant it.
 */
export function rootNeedsAsking(i: Pick<RootInfo, "picked" | "rootExists" | "pending">): boolean {
  if (i.pending) return false;
  if (i.picked === "named") return false;
  if (i.picked === "chosen") return !i.rootExists;
  return true;
}
