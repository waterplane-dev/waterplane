/**
 * The mode picker's pure half: which permission modes the model wheel's popover
 * lists, what it says the current one is, and the words for a switch and for
 * ultracode. The rows mirror the desktop's own mode menu (Manual · Edit
 * automatically · Plan · Auto), worded for a CLI.
 *
 * Split from `core/session/ModelWheel.tsx` so the rules are pinned without a
 * browser (`modePick.test.mjs`). Icons are KEYS here, mapped to lucide in the
 * component, so this file imports no React.
 *
 * Two facts on the wire, never blended: `liveMode` is the CLI's footer read NOW,
 * `permissionMode` is the launch flag. Absent `liveMode` means the footer could
 * not be read — the popover then shows the launch value AND SAYS it is one,
 * never presents it as the current mode.
 */
import type { PermissionMode } from "@waterplane/shared";

export type ModeIcon = "hand" | "code" | "scroll" | "zap" | "shieldOff" | "lock";

export interface ModeDef {
  mode: PermissionMode;
  title: string;
  /** One line, under the title. */
  desc: string;
  icon: ModeIcon;
}

/** The shift+tab cycle as the CLI draws it, in its order. */
export const CYCLE_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "auto"];

/** No approval prompt at all — the same set `core/settings/permModes.ts`'s
 *  `RISKY_PERM_MODES` holds (kept as a literal so this file stays pure; the
 *  test holds the two equal). */
export const RISKY_MODES: readonly PermissionMode[] = ["bypassPermissions", "dontAsk"];

export const MODE_DEFS: Record<PermissionMode, ModeDef> = {
  default: { mode: "default", title: "Manual", desc: "Asks for approval before each edit and command", icon: "hand" },
  acceptEdits: { mode: "acceptEdits", title: "Edit automatically", desc: "Edits files without asking; still asks before other commands", icon: "code" },
  plan: { mode: "plan", title: "Plan", desc: "Explores the code and presents a plan before editing", icon: "scroll" },
  auto: { mode: "auto", title: "Auto", desc: "Approves actions that pass a safety check, pauses for anything risky", icon: "zap" },
  bypassPermissions: { mode: "bypassPermissions", title: "Bypass permissions", desc: "Runs every tool call without asking — nothing is checked", icon: "shieldOff" },
  dontAsk: { mode: "dontAsk", title: "Don’t ask", desc: "Never shows an approval prompt — the permission rules decide alone", icon: "lock" },
};

export function modeTitle(m: PermissionMode): string {
  return MODE_DEFS[m]?.title ?? m;
}

/** What the popover may say about the current mode, and where it came from. */
export type ModeNow =
  | { mode: PermissionMode; source: "live" }
  | { mode: PermissionMode; source: "launch" }
  | { mode: null; source: "unknown" };

export function modeNow(s: { liveMode?: PermissionMode; permissionMode?: PermissionMode }): ModeNow {
  if (s.liveMode) return { mode: s.liveMode, source: "live" };
  if (s.permissionMode) return { mode: s.permissionMode, source: "launch" };
  return { mode: null, source: "unknown" };
}

/** The line above the rows. A launch value is NAMED as one. `readFrom` says where the live reading
 *  comes from: claude's footer, or a source backend's own answer (its label). */
export function modeNowText(now: ModeNow, readFrom = "the CLI’s footer"): string {
  const fromFooter = readFrom === "the CLI’s footer";
  if (now.source === "live") return `Now: ${modeTitle(now.mode)}, read ${fromFooter ? "off" : "from"} ${readFrom}.`;
  if (now.source === "launch") {
    return `Launched in ${modeTitle(now.mode)}. ${fromFooter ? "The footer" : "Its mode"} can’t be read right now, so it may have changed since.`;
  }
  return `${fromFooter ? "The footer" : "Its mode"} can’t be read right now and this session launched with no mode flag, so its mode is not known here.`;
}

/**
 * The rows to draw, in the CLI's order: the shift+tab four this backend lists,
 * then a no-approval mode ONLY when the session is in it or launched in it —
 * shift+tab cannot reach one otherwise, so listing it would offer a switch the
 * host can only refuse. A backend listing no modes gets no rows.
 */
export function modeRows(
  choices: readonly PermissionMode[],
  s: { liveMode?: PermissionMode; permissionMode?: PermissionMode },
  /** True for claude's TUI (shift+tab reaches only the cycle). A source backend's `set()` reaches
   *  any mode it declares, so with `false` every declared mode is a row (a risky one still asks). */
  cycleOnly = true,
): ModeDef[] {
  const rows = CYCLE_MODES.filter((m) => choices.includes(m));
  for (const r of RISKY_MODES) {
    if (choices.includes(r) && (!cycleOnly || s.liveMode === r || s.permissionMode === r)) rows.push(r);
  }
  return rows.map((m) => MODE_DEFS[m]);
}

/** What a tap on a row does: nothing (it is already the live mode), ask first
 *  (a no-approval mode is never armed by one tap), or send. */
export type ModeTap = { kind: "none"; say: string } | { kind: "confirm" } | { kind: "send" };

export function modeTap(mode: PermissionMode, now: ModeNow): ModeTap {
  // Only the LIVE reading counts as "already there": a launch value may be
  // stale, and re-sending is safe (the target is a state, not a step).
  if (now.source === "live" && now.mode === mode) return { kind: "none", say: `already in ${modeTitle(mode)}` };
  if (RISKY_MODES.includes(mode)) return { kind: "confirm" };
  return { kind: "send" };
}

/** The toast for `session.moded`. `reason` is the host's sentence and wins. */
export function modedText(reply: { mode?: PermissionMode; reason?: string }): string {
  if (reply.reason) return reply.reason;
  if (reply.mode) return `now in ${modeTitle(reply.mode)}`;
  return "the desktop switched, but could not read the footer afterwards";
}

/** How long a switch may stay "switching…" before the popover says the host
 *  never answered. The host presses shift+tab at most six times at up to
 *  ~1.5 s each (~9 s worst case, measured 0.2–0.5 s a press), so this sits
 *  past that rather than calling a slow walk a dead host. */
export const MODE_SWITCH_MS = 12000;

export function modeTimeoutText(mode: PermissionMode): string {
  return `the desktop did not answer the switch to ${modeTitle(mode)} — check the footer in the terminal`;
}

/**
 * The mode drawn on the CLOSED wheel button, or null. Read off the footer
 * ONLY: a badge has no room to say "launch value", so a fallback there would be
 * a claim. Manual draws nothing — it is the CLI's own unlabelled state, the
 * footer shows no label for it either.
 */
export function badgeMode(s: { liveMode?: PermissionMode }): PermissionMode | null {
  return s.liveMode && s.liveMode !== "default" ? s.liveMode : null;
}

// ── ultracode ─────────────────────────────────────────────────────────────

export type UltraState = "on" | "off" | "unknown";

export function ultraState(u: boolean | undefined): UltraState {
  return u === true ? "on" : u === false ? "off" : "unknown";
}

/** The state as words. Absent is NOT off: the CLI never confirmed either way. */
export function ultraText(u: boolean | undefined): string {
  const st = ultraState(u);
  if (st === "on") return "on for this session — the CLI confirmed it";
  if (st === "off") return "off — the CLI confirmed it";
  return "not known — the CLI hasn’t confirmed it yet";
}

export function ultraCommand(on: boolean): string {
  return `/effort ultracode ${on ? "on" : "off"}`;
}
