/**
 * The live desktop extension's host half (docs/analysis/desktop-stream-plan.md; the phone half is
 * `web/`, the wire `shared/wire.mts`, the helper's contract `helper/PROTOCOL.md`).
 *
 * Contributes, through the same `HostPluginApi` an external plugin gets:
 * - the stream `screen` (`api.stream`): one `wp-desktop serve` per open view, at most two;
 * - `probe`, `windows` and `grant` (`plugin.call`; `grant` is the view's button for a missing
 *   grant, the same fix the checklist row runs);
 * - the setup rows (helper built, Screen Recording, Accessibility, who macOS asks, control) on the
 *   desktop's own checklist, and their fixes (build now, ask macOS, else open the right pane);
 * - the `control` setting: off until the person turns it on, and with it off every input is
 *   dropped HERE, not just hidden on the phone (§6).
 *
 * Nothing runs at import or at activate: the helper is built on first use, and a helper process
 * exists only while a view is open.
 */
import { spawn } from "node:child_process";
import type { HostPluginApi } from "@waterplane/shared";
import { STREAM_NAME, type DesktopMethods } from "../shared/wire.mjs";
import { createDesktop, type Desktop } from "./desktop.mjs";
import { HELPER, detectDesktopOs, helperSourceDir, prebuiltHelper, syntheticMode } from "./knobs.mjs";
import { FIX_ACCESSIBILITY, FIX_SCREEN, desktopFixes, desktopRows } from "./setup.mjs";

export { createDesktop } from "./desktop.mjs";

let current: { desktop: Desktop; offs: (() => void)[] } | null = null;

const ROW_IDS = ["desktop-helper", "desktop-screen-recording", "desktop-accessibility", "desktop-responsible", "desktop-control"] as const;

/** `open <url>` on this desktop: a System Settings pane a person asked for with a tap. */
function openUrl(url: string): void {
  try { spawn("/usr/bin/open", [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch { /* nothing to open with */ }
}

export function activate(api: HostPluginApi): void {
  let controlOn = api.settings().control === true;
  const os = detectDesktopOs();
  const desktop = createDesktop({
    platform: process.platform,
    os,
    stateDir: api.stateDir,
    sourceDir: helperSourceDir(undefined, HELPER[os ?? "mac"].dir),
    prebuilt: prebuiltHelper(),
    synthetic: syntheticMode(),
    log: (m) => api.log(m),
    control: () => controlOn,
  });
  const offs: (() => void)[] = [];
  offs.push(api.stream(STREAM_NAME, desktop.handlers));
  // `DesktopMethods` is an interface (no index signature), so each method is registered by name.
  const probe: () => Promise<DesktopMethods["probe"]["result"]> = () => desktop.prober.probe();
  const windows: () => Promise<DesktopMethods["windows"]["result"]> = () => desktop.prober.windows();
  offs.push(api.handle("probe", probe), api.handle("windows", windows));
  offs.push(api.onSettings((v) => {
    const next = v.control === true;
    if (next === controlOn) return;
    controlOn = next;
    desktop.controlChanged(next);
  }));

  // One setup row per registered check; the rows are computed once per look, not once per row.
  const setup = { platform: process.platform, os, bin: desktop.bin, prober: desktop.prober, control: () => controlOn, openUrl, log: (m: string) => api.log(m) };
  let memo: { at: number; rows: ReturnType<typeof desktopRows> } | null = null;
  const rows = (): ReturnType<typeof desktopRows> => {
    if (!memo || Date.now() - memo.at > 500) memo = { at: Date.now(), rows: desktopRows(setup) };
    return memo.rows;
  };
  for (const id of ROW_IDS) offs.push(api.setupCheck(() => rows().find((r) => r.id === id) ?? null));
  const fixes = desktopFixes(setup);
  for (const [id, fn] of Object.entries(fixes)) offs.push(api.setupFix(id, fn));
  // The view's own button for the grant it is missing: the very fix the checklist row runs.
  const grant = (a: unknown): DesktopMethods["grant"]["result"] =>
    fixes[(a as { kind?: unknown } | null)?.kind === "accessibility" ? FIX_ACCESSIBILITY : FIX_SCREEN]!();
  offs.push(api.handle("grant", grant));

  current = { desktop, offs };
}

export function deactivate(): void {
  if (!current) return;
  current.desktop.stopAll();
  for (const off of current.offs) { try { off(); } catch { /* already gone */ } }
  current = null;
}
