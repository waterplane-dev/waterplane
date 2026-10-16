/**
 * The live desktop's rows in the setup checklist (`api.setupCheck`), all `scope: "host"`: they are
 * about this desktop, never about a repo, so they are drawn on the desktop's own checklist
 * (Settings → *desktop setup*, `GET /api/host/setup`) and no repo's checklist lists them.
 * macOS and Windows (a host in WSL); elsewhere there is nothing a person here could do, so there are
 * no rows. Windows grants nothing per app, so it has no Accessibility or permission-owner row, its
 * "Screen Recording" row says whether the helper can see the signed-in desktop, and the ask fixes
 * say there is nothing to ask. And only
 * once the desktop has been USED (the helper exists, is being built, failed to build, or a probe
 * answered): before that, five rows about a view nobody opened would sit on every repo's sheet,
 * and the view itself says what is missing the first time it is opened.
 *
 * Every row reads what is already known (the helper's state, the last probe) and never runs or
 * builds anything itself; a stale probe of a built helper is refreshed in the background for the
 * next look. The fixes are a person's tap: build now, or ASK macOS for the missing grant.
 *
 * Asking is `wp-desktop request screen|accessibility` (helper/PROTOCOL.md): the dialog appears on
 * the desktop's screen, names wp-desktop (the helper disclaims node's responsibility first) and
 * lists it in the pane, so nobody has to add a binary by path. macOS asks for Screen Recording
 * once per build of the binary, so a second tap on the same build opens the System Settings pane
 * instead, as does a helper that is not built or fails to run. `+` and the binary's path stay in
 * the row text as the last resort.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { ComplianceCheck, SetupFixOutcome } from "@waterplane/shared";
import type { HelperBin, Runner } from "./helperbin.mjs";
import { runFile } from "./helperbin.mjs";
import { NEEDS_ACCESSIBILITY, NEEDS_SCREEN_RECORDING, NOT_MAC, NOT_RESPONSIBLE, NO_TOOLCHAIN, PANE_ACCESSIBILITY, PANE_SCREEN, REBUILT, WIN_NO_DESKTOP, osOf, type DesktopOs } from "./knobs.mjs";
import type { Prober } from "./probe.mjs";
import { CONTROL_SETTING_PATH, CONTROL_SWITCH } from "../shared/wire.mjs";

export const FIX_BUILD = "desktop-helper";
export const FIX_SCREEN = "desktop-screen-recording";
export const FIX_ACCESSIBILITY = "desktop-accessibility";

export interface SetupDeps {
  platform: NodeJS.Platform;
  /** Overrides what `platform` alone says (`detectDesktopOs`: a WSL host is `windows`). */
  os?: DesktopOs | null;
  bin: HelperBin;
  prober: Prober;
  control(): boolean;
  /** Open a System Settings URL on this desktop (`open <url>`). */
  openUrl(url: string): void;
  /** Runs `wp-desktop request …` (default: the real process). */
  run?: Runner;
  log?(msg: string): void;
}

const REQUEST_TIMEOUT_MS = 60_000;

const row = (id: string, label: string, status: ComplianceCheck["status"], detail: string, fix: string | null = null): ComplianceCheck =>
  ({ id, label, status, detail, fix, scope: "host" });

const addHint = (path: string): string => ` Tap Fix and macOS asks on the desktop's screen. If it does not ask, click + in that pane and choose ${path} (⇧⌘G takes a typed path).`;

/** The rows, in order. Empty off macOS and Windows. */
export function desktopRows(d: SetupDeps): ComplianceCheck[] {
  const os = osOf(d);
  if (os === null) return [];
  if (os === "windows") return windowsRows(d);
  const st = d.bin.state();
  const probe = d.prober.cached();
  void d.prober.refreshIfBuilt().catch(() => { /* the next look says it */ });
  if (!probe && (st.kind === "unknown" || st.kind === "missing" || st.kind === "no-source")) return [];
  const rows: ComplianceCheck[] = [];
  const control = d.control();

  // 1. the helper
  switch (st.kind) {
    case "current": case "prebuilt":
      rows.push(st.rebuiltAt
        ? row("desktop-helper", "Live desktop helper", "warn", `${REBUILT} It is at ${st.path}.`)
        : row("desktop-helper", "Live desktop helper", "pass", `wp-desktop is built at ${st.path}${st.hash ? ` (source ${st.hash})` : ""}.`));
      break;
    case "building":
      rows.push(row("desktop-helper", "Live desktop helper", "warn", "wp-desktop is being built now (about a minute)."));
      break;
    case "stale":
      rows.push(row("desktop-helper", "Live desktop helper", "warn",
        "wp-desktop's source changed since it was built. It is rebuilt when the desktop view next opens, and macOS then forgets its Screen Recording and Accessibility grants: grant both again afterwards.", FIX_BUILD));
      break;
    case "no-toolchain":
      rows.push(row("desktop-helper", "Live desktop helper", "fail", NO_TOOLCHAIN));
      break;
    case "failed": case "no-source":
      rows.push(row("desktop-helper", "Live desktop helper", "fail", st.reason ?? "wp-desktop could not be built.", st.kind === "failed" ? FIX_BUILD : null));
      break;
    default:
      rows.push(row("desktop-helper", "Live desktop helper", "warn", "wp-desktop is not built yet. It is built the first time the desktop view is opened, or now with Fix.", FIX_BUILD));
  }

  // 2. Screen Recording
  if (!probe) rows.push(row("desktop-screen-recording", "Live desktop: Screen Recording", "warn", "Not checked yet: it is read once wp-desktop is built."));
  else if (probe.screenRecording) rows.push(row("desktop-screen-recording", "Live desktop: Screen Recording", "pass", "wp-desktop may record the screen."));
  else rows.push(row("desktop-screen-recording", "Live desktop: Screen Recording", "fail", NEEDS_SCREEN_RECORDING + addHint(st.path), FIX_SCREEN));

  // 3. Accessibility: only matters with control on
  if (!probe) rows.push(row("desktop-accessibility", "Live desktop: Accessibility", control ? "warn" : "pass",
    control ? "Not checked yet: it is read once wp-desktop is built." : "Only needed once control is turned on."));
  else if (probe.accessibility) rows.push(row("desktop-accessibility", "Live desktop: Accessibility", "pass", "wp-desktop may post clicks and keys."));
  else if (!control) rows.push(row("desktop-accessibility", "Live desktop: Accessibility", "pass", "Not granted, and not needed while control is off. Turning control on needs it." + addHint(st.path), FIX_ACCESSIBILITY));
  else rows.push(row("desktop-accessibility", "Live desktop: Accessibility", "fail", NEEDS_ACCESSIBILITY + addHint(st.path), FIX_ACCESSIBILITY));

  // 4. who macOS asks about
  if (probe?.responsibleSelf === false) rows.push(row("desktop-responsible", "Live desktop: permission owner", "warn", NOT_RESPONSIBLE));
  else if (probe?.responsibleSelf === true) rows.push(row("desktop-responsible", "Live desktop: permission owner", "pass", "macOS judges wp-desktop itself, not node, for both grants."));

  // 5. the control setting, said out loud
  rows.push(row("desktop-control", "Live desktop: control", "pass", control
    ? "Control is on: clicks and keys from the phone reach every app on this desktop."
    : `Control is off: the phone can watch this desktop but not click or type. Turn on "${CONTROL_SWITCH}" in ${CONTROL_SETTING_PATH}.`));
  return rows;
}

/** Windows: the helper, whether it can see the signed-in desktop, and the control setting. */
function windowsRows(d: SetupDeps): ComplianceCheck[] {
  const st = d.bin.state();
  const probe = d.prober.cached();
  if (!probe && (st.kind === "unknown" || st.kind === "missing" || st.kind === "no-source")) return [];
  const rows: ComplianceCheck[] = [];
  switch (st.kind) {
    case "current": case "prebuilt":
      rows.push(row("desktop-helper", "Live desktop helper", "pass", `wp-desktop.exe is built at ${st.path}${st.hash ? ` (source ${st.hash})` : ""}.`));
      break;
    case "building":
      rows.push(row("desktop-helper", "Live desktop helper", "warn", "wp-desktop.exe is being built now (a few seconds)."));
      break;
    case "stale":
      rows.push(row("desktop-helper", "Live desktop helper", "warn", "wp-desktop.exe's source changed since it was built. It is rebuilt when the desktop view next opens, or now with Fix.", FIX_BUILD));
      break;
    case "no-toolchain": case "failed": case "no-source":
      rows.push(row("desktop-helper", "Live desktop helper", "fail", st.reason ?? "wp-desktop.exe could not be built.", st.kind === "failed" ? FIX_BUILD : null));
      break;
    default:
      rows.push(row("desktop-helper", "Live desktop helper", "warn", "wp-desktop.exe is not built yet. It is built the first time the desktop view is opened, or now with Fix.", FIX_BUILD));
  }
  if (!probe) rows.push(row("desktop-screen-recording", "Live desktop: Windows desktop", "warn", "Not checked yet: it is read once wp-desktop.exe is built."));
  else if (probe.screenRecording) rows.push(row("desktop-screen-recording", "Live desktop: Windows desktop", "pass", "wp-desktop.exe runs in the signed-in desktop and can show it. Windows asks no permission for that, nor for clicks and keys."));
  else rows.push(row("desktop-screen-recording", "Live desktop: Windows desktop", "fail", WIN_NO_DESKTOP));
  rows.push(row("desktop-control", "Live desktop: control", "pass", d.control()
    ? "Control is on: clicks and keys from the phone reach every app on this desktop, except windows running as administrator (Windows blocks input into those)."
    : `Control is off: the phone can watch this desktop but not click or type. Turn on "${CONTROL_SWITCH}" in ${CONTROL_SETTING_PATH}.`));
  return rows;
}

/** Said by an ask fix on Windows, which has no grant to ask for. */
export const WINDOWS_ASKS_NOTHING = "Windows asks no permission to show the screen or to click and type: there is nothing to grant.";

export function desktopFixes(d: SetupDeps): Record<string, () => SetupFixOutcome> {
  return {
    [FIX_BUILD]: () => {
      if (osOf(d) === null) return { applied: false, note: NOT_MAC };
      if (d.bin.isBuilding) return { applied: false, note: "wp-desktop is already being built." };
      void d.bin.build().then(() => d.prober.forget());
      return { applied: true, note: osOf(d) === "windows" ? "Building wp-desktop.exe now (a few seconds)." : "Building wp-desktop now (about a minute). A rebuild means granting Screen Recording and Accessibility again." };
    },
    [FIX_SCREEN]: () => askMacOS(d, "screen"),
    [FIX_ACCESSIBILITY]: () => askMacOS(d, "accessibility"),
  };
}

const KINDS = {
  screen: { pane: PANE_SCREEN, where: "Screen Recording" },
  accessibility: { pane: PANE_ACCESSIBILITY, where: "Accessibility" },
} as const;

/** Said when the tap made macOS show its dialog. */
/** macOS's dialog for either grant offers "Open System Settings" and "Deny" — no Allow — and neither grants: the switch does. */
export const MACOS_IS_ASKING = "macOS is asking on the desktop's screen. Its \"Open System Settings\" button grants nothing by itself: turn on wp-desktop in the list it opens.";

/**
 * Ask macOS for one grant. Returns at once (a fix is synchronous): the helper runs in the
 * background and only affects what the NEXT look at the row says. Whether a dialog really appeared
 * cannot be seen from here, so "asked once for this build" is remembered beside the binary and the
 * second tap goes to the pane (macOS shows the Screen Recording dialog once per binary).
 */
function askMacOS(d: SetupDeps, kind: keyof typeof KINDS): SetupFixOutcome {
  const { pane, where } = KINDS[kind];
  const open = (why: string): SetupFixOutcome => {
    d.openUrl(pane);
    return { applied: true, note: `${why} Opened System Settings → Privacy & Security → ${where} on the desktop: turn on wp-desktop (or add ${d.bin.path} with +).` };
  };
  const os = osOf(d);
  if (os === null) return { applied: false, note: NOT_MAC };
  if (os === "windows") return { applied: false, note: WINDOWS_ASKS_NOTHING };
  const st = d.bin.state();
  if (!["current", "prebuilt", "stale"].includes(st.kind) || !existsSync(d.bin.path)) return open("wp-desktop is not built yet, so it cannot ask.");
  const marker = `${d.bin.path}.asked-${kind}`;
  const build = st.hash ?? st.kind;
  if (kind === "screen" && readText(marker) === build) return open("macOS asks for Screen Recording only once per build of wp-desktop, and it was asked.");
  try { writeFileSync(marker, build); } catch { /* the marker only decides the NEXT tap */ }
  const run = d.run ?? runFile;
  void run(d.bin.path, ["request", kind], REQUEST_TIMEOUT_MS).then((r) => {
    let granted: boolean | null = null;
    try {
      const o = JSON.parse(r.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "") as Record<string, { granted?: unknown } | undefined>;
      if (typeof o[kind]?.granted === "boolean") granted = o[kind]!.granted as boolean;
    } catch { /* not JSON: handled as a failure below */ }
    if (granted === null) {
      try { unlinkSync(marker); } catch { /* none */ }
      d.log?.(`wp-desktop request ${kind} failed: ${r.stderr.trim().split("\n").at(-1) || r.error || `exit ${r.code}`}; opening the pane instead`);
      d.openUrl(pane);
      return;
    }
    d.prober.forget(); // the next look re-reads the grant
  }).catch(() => { d.openUrl(pane); });
  return { applied: true, note: `${MACOS_IS_ASKING} The row updates once it is granted.` };
}

function readText(p: string): string | undefined {
  try { return readFileSync(p, "utf8").trim() || undefined; } catch { return undefined; }
}
