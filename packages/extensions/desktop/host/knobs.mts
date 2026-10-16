/**
 * The live desktop's knobs, the words it says, and where the helper's source lives. Read at CALL
 * time, never at import, so nothing here runs before the daemon has loaded its `.env` files.
 *
 * - `WATERPLANE_DESKTOP_SYNTHETIC=1` (tests only): every helper runs the synthetic test pattern with
 *   `--no-capture --dry-input`, so nothing touches the real screen and no event is posted. A phone
 *   can never pick it: `cleanDesktopParams` has no such source, so only the desktop's own
 *   environment can.
 * - `WATERPLANE_DESKTOP_HELPER=<path>`: run this `wp-desktop` instead of building one (a prebuilt
 *   binary, or a test's fake). Nothing is built or hashed then.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeEnvReader } from "@waterplane/shared";
import { CONTROL_SETTING_PATH, CONTROL_SWITCH } from "../shared/wire.mjs";

const { env } = makeEnvReader(process.env, (text) => console.warn(text));

export function syntheticMode(): boolean {
  return /^(1|true|yes|on)$/i.test((env("DESKTOP_SYNTHETIC") ?? "").trim());
}

export function prebuiltHelper(): string | null {
  const v = (env("DESKTOP_HELPER") ?? "").trim();
  return v || null;
}

/**
 * Which desktop this host can show: `mac` (the Swift helper), `windows` (the C# helper, reached
 * from a host running in WSL through its interop), or null. A WSL distro with interop switched
 * off is still `windows`: its build fails with the sentence that says how to switch it on.
 */
export type DesktopOs = "mac" | "windows";

export function detectDesktopOs(platform: NodeJS.Platform = process.platform): DesktopOs | null {
  if (platform === "darwin") return "mac";
  if (platform !== "linux") return null;
  let wsl = !!process.env.WSL_DISTRO_NAME;
  if (!wsl) { try { wsl = /microsoft/i.test(readFileSync("/proc/sys/kernel/osrelease", "utf8")); } catch { /* not Linux-on-Windows */ } }
  return wsl ? "windows" : null;
}

/** The OS a deps object means: its explicit `os`, else what its platform alone says (tests pass "darwin"/"linux"). */
export function osOf(d: { os?: DesktopOs | null; platform: NodeJS.Platform }): DesktopOs | null {
  return d.os !== undefined ? d.os : d.platform === "darwin" ? "mac" : null;
}

/** The helper's source directory and binary name, per OS. */
export const HELPER = {
  mac: { dir: "helper", bin: "wp-desktop" },
  windows: { dir: "helper-win", bin: "wp-desktop.exe" },
} as const;

/**
 * `packages/extensions/desktop/helper/` (or `helper-win/`), from wherever this module runs:
 * - built: `packages/host/dist/extensions/desktop/host/*.mjs` (the host's second `tsc`);
 * - dev under tsx: `packages/extensions/desktop/host/*.mts`.
 * The first candidate holding `build.sh` wins; none ⇒ null (a release that left the source out).
 */
export function helperSourceDir(from: string = import.meta.url, dir: string = HELPER.mac.dir): string | null {
  for (const rel of [`../${dir}/`, `../../../../../extensions/desktop/${dir}/`]) {
    const dir = fileURLToPath(new URL(rel, from));
    if (existsSync(dir + "build.sh")) return dir.replace(/\/$/, "");
  }
  return null;
}

/** Open subscriptions (each its own helper process) this host serves at once, over every socket. */
export const MAX_STREAMS = 2;

export const NOT_MAC = "Live desktop needs a macOS desktop, or a Windows one with the host running in WSL, for now.";
export const NO_TOOLCHAIN = "Install Xcode command line tools (xcode-select --install) on the desktop.";
export const NO_TOOLCHAIN_WIN = "The Windows helper is compiled by the .NET Framework's csc.exe (in C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319), reached through WSL interop, and it was not found. Turn interop on in /etc/wsl.conf ([interop] enabled=true), or install .NET Framework 4.8.";
/** A Windows helper that cannot see the signed-in desktop (session 0, or the secure desktop). */
export const WIN_NO_DESKTOP = "wp-desktop cannot see the signed-in Windows desktop: either the host runs outside the user's session (a scheduled task set to run whether the user is logged on or not, which Windows starts in session 0), or the screen is locked or showing a UAC prompt. Unlock the PC; if that is not it, set the host's task to \"Run only when user is logged on\".";
export const NO_SOURCE = "This install carries no source for the desktop helper (wp-desktop), so it cannot be built here.";
export const BUILDING = "The desktop helper (wp-desktop) is being built. That takes about a minute the first time; open the desktop again then.";
/** Only while every slot is a view still being OPENED (nothing open yet to hand over). */
export const TOO_MANY = `This desktop is already opening ${MAX_STREAMS} views. Try again in a moment.`;
/** The oldest view, ended so a newer one could open (cause `replaced`). */
export const REPLACED = "The live view was opened on another screen.";

export const CONTROL_OFF = `Control is off: the phone can watch but not click. Turn on "${CONTROL_SWITCH}" in ${CONTROL_SETTING_PATH}.`;
export const NEEDS_ACCESSIBILITY = "Control needs Accessibility for wp-desktop: without it macOS drops every click and key. On the Mac, open System Settings → Privacy & Security → Accessibility and turn on wp-desktop (+ adds it if it is not listed). A dialog's \"Open System Settings\" grants nothing by itself; only that switch does.";
export const NEEDS_SCREEN_RECORDING = "Screen Recording is not granted to wp-desktop. On the Mac, open System Settings → Privacy & Security → Screen Recording and turn on wp-desktop (+ adds it if it is not listed).";
export const NOT_RESPONSIBLE = "macOS would attribute the permission to node, not to wp-desktop: every node script on this desktop would share the grant, and a node upgrade would lose it. The helper disclaims this itself; if this stays, run the host as a launchd agent or from a terminal.";
export const REBUILT = "wp-desktop was rebuilt because its source changed, and macOS ties Screen Recording and Accessibility to the exact binary: grant both again.";

export const PANE_SCREEN = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
export const PANE_ACCESSIBILITY = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
