/**
 * The desktop checklist's `tailscale-watchdog` row, and its fix: a LaunchAgent
 * that brings Tailscale back after macOS ended it.
 *
 * Why (2026-10-21): with the disk nearly full, macOS's `cache_delete` ends apps
 * to empty their caches (`OS_REASON_RUNNINGBOARD … CacheDeleteAppContainerCaches`).
 * It ended Tailscale's network extension six times in twenty minutes; on-demand
 * reconnected it within seconds each time, except once, when the app went too
 * and Tailscale stayed STOPPED — the phone lost the desktop. The OS has no
 * exemption for an app; the standalone `tailscaled` (a system daemon, no app
 * container) is the lasting answer, so a pass here still names it.
 *
 *  - **The watchdog acts on one state only**: Tailscale reports stopped AND the
 *    Tailscale app is not running. Turning Tailscale off from its menu leaves the
 *    app running, so a person's own "off" is never undone.
 *  - **The fix only adds**: a script under the config dir and a LaunchAgent; it
 *    overwrites only its own files and never touches Tailscale's settings.
 *  - macOS with the Tailscale app only; absent everywhere else.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { BRAND, type ComplianceCheck, type SetupFixOutcome } from "@waterplane/shared";
import { configDir } from "./branddirs.js";
import { writeTextAtomic } from "./jsonstore.js";

export const TAILSCALE_WATCHDOG_FIX = "tailscale-watchdog";
const ID = "tailscale-watchdog";
const LABEL_TEXT = "Tailscale comes back if macOS ends it";
const APP = "/Applications/Tailscale.app";
const CLI = `${APP}/Contents/MacOS/Tailscale`;

/** The LaunchAgent's label: the host's own, with `.host` swapped for this job. */
export function watchdogLabel(hostLabel = BRAND.launchdLabel): string {
  return hostLabel.replace(/\.host$/, "") + ".tailscale-watchdog";
}

/** The script the agent runs every minute. Pure, so the one rule it holds is testable. */
export function watchdogScript(cli = CLI): string {
  return `#!/bin/sh
# ${BRAND.displayName}: bring Tailscale back after macOS ended it to free disk space.
# Acts only when Tailscale reports stopped AND the Tailscale app is not running:
# turning Tailscale off from its menu leaves the app running, and is left alone.
TS="${cli}"
LOG="$HOME/Library/Logs/${BRAND.name}-tailscale-watchdog.log"
[ -x "$TS" ] || exit 0
case "$("$TS" status 2>&1)" in *"Tailscale is stopped"*) ;; *) exit 0 ;; esac
pgrep -xq Tailscale && exit 0
echo "$(date '+%F %T') stopped with the app gone: reopening Tailscale" >> "$LOG"
open -g -a Tailscale
sleep 10
case "$("$TS" status 2>&1)" in
  *"Tailscale is stopped"*) echo "$(date '+%F %T') still stopped: tailscale up" >> "$LOG"; "$TS" up >> "$LOG" 2>&1 ;;
esac
exit 0
`;
}

export function watchdogPlist(label: string, script: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>${script}</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;
}

const plistPath = (label: string) => join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
const scriptPath = () => join(configDir(), "tailscale-watchdog.sh");
const domain = () => `gui/${os.userInfo().uid}`;

function launchctl(args: string[]): boolean {
  try { execFileSync("launchctl", args, { stdio: "ignore", timeout: 5000 }); return true; } catch { return false; }
}

/** The standalone daemon (Homebrew's `tailscaled`) is running: no app container to purge. */
function standaloneDaemon(): boolean {
  try { execFileSync("pgrep", ["-xq", "tailscaled"], { stdio: "ignore", timeout: 3000 }); return true; } catch { return false; }
}

const LASTING = "The lasting fix is the standalone `tailscaled` (Homebrew, a system daemon with no app for macOS to end) — " +
  "it joins the tailnet as a new device, so pairing and `tailscale serve` are set up again.";

/** The row, or null where it is not a question (not macOS, no Tailscale app). */
export function tailscaleWatchdogRow(platform = process.platform): ComplianceCheck | null {
  if (platform !== "darwin") return null;
  if (standaloneDaemon()) {
    return { id: ID, label: LABEL_TEXT, status: "pass", scope: "host", fix: null,
      detail: "Tailscale runs as the standalone `tailscaled` daemon, which macOS's disk cleanup does not end." };
  }
  if (!existsSync(APP)) return null;
  const label = watchdogLabel();
  if (existsSync(plistPath(label)) && launchctl(["print", `${domain()}/${label}`])) {
    return { id: ID, label: LABEL_TEXT, status: "pass", scope: "host", fix: null,
      detail: `A watchdog (${label}) checks every minute and reopens Tailscale when macOS ended it. ${LASTING}` };
  }
  return { id: ID, label: LABEL_TEXT, status: "warn", scope: "host", fix: TAILSCALE_WATCHDOG_FIX,
    detail: "When the disk runs low, macOS ends apps to empty their caches — Tailscale among them — and the phone " +
      "loses this desktop until someone restarts it here. The fix installs a watchdog that checks every minute and " +
      "reopens Tailscale only when it is stopped and its app is gone, so turning Tailscale off yourself still works. " + LASTING };
}

/** Install (or re-install) the watchdog: its script, its LaunchAgent, loaded now. */
export function installTailscaleWatchdog(): SetupFixOutcome {
  const label = watchdogLabel();
  const script = scriptPath();
  const plist = plistPath(label);
  try {
    mkdirSync(configDir(), { recursive: true });
    writeTextAtomic(script, watchdogScript(), { mode: 0o755 });
    mkdirSync(join(os.homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeTextAtomic(plist, watchdogPlist(label, script));
  } catch (e) {
    return { applied: false, note: `Could not write the watchdog: ${(e as Error).message}` };
  }
  launchctl(["bootout", `${domain()}/${label}`]);
  if (!launchctl(["bootstrap", domain(), plist])) {
    return { applied: false, note: `Wrote ${plist} but launchd did not load it; \`launchctl bootstrap ${domain()} ${plist}\` on the desktop retries.` };
  }
  return { applied: true, note: `Tailscale watchdog installed (${label}); it checks every minute and logs what it did to ~/Library/Logs/${BRAND.name}-tailscale-watchdog.log.` };
}
