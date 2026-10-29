/**
 * `launchModes` (plugin API 2.2): the subset of `caps.permissionModes` a session can START in.
 * A backend may switch into a mode LIVE that it has no launch flag for (Codex's `plan`), so the
 * launch pickers read this and the live mode switch keeps reading `permissionModes`.
 * ABSENT ⇒ every `permissionModes` entry (today's behaviour). Pure: host and phone ask the same
 * functions, so the picker and the refusal cannot word two rules.
 */
import type { PermissionMode } from "./wire/session.js";

/** Every mode name the wire knows — the runtime twin of the `PermissionMode` type. */
export const PERMISSION_MODE_NAMES: readonly PermissionMode[] = ["default", "plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions"];

/** The modes a launch may name: `launchModes` when declared, else every `permissionModes` entry. */
export function launchModesOf(caps: { permissionModes: readonly PermissionMode[]; launchModes?: readonly PermissionMode[] }): readonly PermissionMode[] {
  return caps.launchModes ?? caps.permissionModes;
}

/** Why a declared `launchModes` cannot be registered, as sentences; empty when it can (or is absent). */
export function launchModesProblems(permissionModes: readonly unknown[], launchModes: unknown): string[] {
  if (launchModes === undefined) return [];
  if (!Array.isArray(launchModes)) return ["caps.launchModes must be a list of permission modes (or absent for every permissionModes entry)"];
  if (launchModes.length === 0) return ["caps.launchModes is empty; a backend that launches in no mode cannot be described, so leave it out to launch in every permissionModes entry"];
  const out: string[] = [];
  const unknown = launchModes.filter((m) => !(PERMISSION_MODE_NAMES as readonly unknown[]).includes(m));
  if (unknown.length) out.push(`caps.launchModes names ${unknown.map((m) => JSON.stringify(m)).join(", ")}, which ${unknown.length === 1 ? "is" : "are"} not a known permission mode; the modes are: ${PERMISSION_MODE_NAMES.join(", ")}`);
  const outside = launchModes.filter((m) => (PERMISSION_MODE_NAMES as readonly unknown[]).includes(m) && !permissionModes.includes(m));
  if (outside.length) out.push(`caps.launchModes names ${outside.map((m) => JSON.stringify(m)).join(", ")}, which ${outside.length === 1 ? "is" : "are"} not in caps.permissionModes (${permissionModes.join(", ") || "none"}); a session can only start in a mode the backend understands`);
  // A repeat would draw the same row twice in every launch picker.
  const twice = [...new Set(launchModes.filter((m, i) => launchModes.indexOf(m) !== i))];
  if (twice.length) out.push(`caps.launchModes names ${twice.map((m) => JSON.stringify(m)).join(", ")} more than once; list each mode once`);
  return out;
}

/** Why a declared `spendUnit` (2.3) cannot be registered, as sentences; empty when it can (or is absent). */
export function spendUnitProblems(spendUnit: unknown): string[] {
  if (spendUnit === undefined) return [];
  if (typeof spendUnit !== "string" || !spendUnit.trim()) return ["caps.spendUnit must be the unit's name as a person reads it (\"AI credits\"), or absent when the backend bills in tokens or dollars"];
  if (spendUnit.trim().length > 32) return [`caps.spendUnit is ${spendUnit.trim().length} characters; a unit name is at most 32`];
  if (spendUnit !== spendUnit.trim()) return ["caps.spendUnit has spaces around it; write the name as it is read"];
  return [];
}

/** The sentence for a launch that names a mode outside the backend's launch set; null when it may start. */
export function launchModeRefusal(label: string, mode: string | undefined, caps: { permissionModes: readonly PermissionMode[]; launchModes?: readonly PermissionMode[] }): string | null {
  if (mode === undefined) return null;
  const set = launchModesOf(caps);
  if ((set as readonly string[]).includes(mode)) return null;
  const live = (caps.permissionModes as readonly string[]).includes(mode);
  return `${label} cannot start in "${mode}" mode${live ? " (it can switch to it once running)" : ""}; it starts in: ${set.join(", ") || "no mode"}.`;
}
