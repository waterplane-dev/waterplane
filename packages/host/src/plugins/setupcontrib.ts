/**
 * The seam between the setup checklist (`compliance.ts`) and the rows plugins
 * and in-repo extensions contribute through `api.setupCheck`/`api.setupFix`.
 *
 * `compliance.ts` is plain functions called from routes, the sweep and tests,
 * and must not import the registry (which imports the session manager). So the
 * registry registers itself here at construction and the checklist asks this
 * module. No registry ⇒ no contributed rows — which is the state a `--doctor`
 * run or a test that booted none is honestly in.
 */
import type { BackendInfo, ComplianceCheck, SetupFixOutcome, SetupSubject } from "@waterplane/shared";
import { BACKENDS, backendInfos } from "../backends/index.js";
import type { BackendDescriptor } from "../backends/index.js";
import { onPath } from "../pathx.js";
import { existsSync } from "node:fs";
import { TAILSCALE_WATCHDOG_FIX, installTailscaleWatchdog, tailscaleWatchdogRow } from "../tailscaleguard.js";

export interface SetupSource {
  setupChecks(s: SetupSubject): ComplianceCheck[];
  setupFixIds(): string[];
  runSetupFix(id: string, s: SetupSubject): SetupFixOutcome | null;
}

let source: SetupSource | null = null;

export function setSetupSource(s: SetupSource | null): void { source = s; }

/** The fix ids active plugins and extensions answer right now; none without a registry. */
export function contributedFixIds(): string[] { return source ? source.setupFixIds() : []; }

/**
 * Every contributed row ABOUT this worktree, in load order. A `scope: "host"` row is about the
 * desktop, never the repo it would be listed under, so it is left out here and drawn once, on the
 * desktop's own checklist (`hostChecks`).
 */
export function contributedChecks(worktree: string): ComplianceCheck[] {
  return source ? source.setupChecks({ worktree }).filter((c) => c.scope !== "host") : [];
}

/**
 * The desktop's checklist: core's own desktop rows, then every contributed `scope: "host"` row. No repo is the subject, so the
 * subject is the root the repos are found under.
 */
export function hostChecks(root: string): ComplianceCheck[] {
  // Core's own desktop rows first (`tailscaleguard.ts`, the backends' version drift), then the contributed ones.
  const core = [tailscaleWatchdogRow(), ...backendCliRows(), ...backendDriftRows()].filter((c): c is ComplianceCheck => c !== null);
  return [...core, ...(source ? source.setupChecks({ worktree: root }).filter((c) => c.scope === "host") : [])];
}

/**
 * One row per PLUGIN backend (one that declares `measured`): is its CLI on this desktop, and which
 * version answered. Generated from the descriptor alone, so a backend added tomorrow gets it with
 * no plugin code. Sync and free: `bin()` is resolved on PATH (or as a path) and the version is the
 * one `primeBackendModels` already asked (`BackendInfo.measured.running`) — nothing is launched
 * here and no model is called. `ok` says where it was found and the version, or that the binary
 * did not say one (absent, never a guess); `warn` says it is not installed. Never a fail and no
 * fix: whether to install it is the person's call (the plugin's README names the command). "Signed
 * in" is per CLI and comes from the plugin through `api.setupCheck`.
 */
export function backendCliRows(
  defs: readonly BackendDescriptor[] = BACKENDS,
  infos: readonly BackendInfo[] = backendInfos(),
  resolve: (bin: string) => string | null = (b) => (b.includes("/") ? (existsSync(b) ? b : null) : onPath(b)),
): ComplianceCheck[] {
  return defs.filter((d) => d.measured).map((d): ComplianceCheck => {
    let bin: string | null = null;
    let why = "";
    try { bin = d.bin(); } catch (e) { why = (e as Error).message; }
    const found = bin ? resolve(bin) : null;
    const label = `${d.label} CLI`;
    if (!found) {
      return { id: `backend-cli-${d.id}`, label, status: "warn", scope: "host", fix: null,
        detail: bin ? `\`${bin}\` was not found on this desktop's PATH, so ${d.label} sessions cannot start.` : `${d.label} names no binary to run (${why || "no answer"}).` };
    }
    const running = infos.find((i) => i.id === d.id)?.measured?.running;
    return { id: `backend-cli-${d.id}`, label, status: "pass", scope: "host", fix: null,
      detail: running ? `${found}, version ${running}.` : `${found}; it did not say which version.` };
  });
}

/**
 * One `warn` row per plugin backend whose running CLI is none of the versions it was measured on
 * (`BackendInfo.measured.drift`, plan §3.6). The detail is the host's own sentence, verbatim — the
 * words the phone shows where a backend is chosen, so the two never read differently. Absent when
 * there is no drift (core backends carry no `measured`; a binary that could not tell is no drift).
 * Never a fail and no fix: the backend still starts, and only the plugin's author can measure it on
 * the new version. A `--doctor` run loads no plugins, so it has no plugin backend to report on.
 */
export function backendDriftRows(infos: readonly BackendInfo[] = backendInfos()): ComplianceCheck[] {
  return infos.flatMap((b): ComplianceCheck[] => b.measured?.drift
    ? [{ id: `backend-drift-${b.id}`, label: `${b.label} runs a version it was not measured on`, status: "warn", scope: "host", fix: null, detail: b.measured.drift }]
    : []);
}

/**
 * Run the fixes among `fixes` that a desktop row names right now — never a repo row's fix, which
 * needs that repo as its subject.
 */
export function hostFixes(fixes: readonly string[], root: string): { id: string; outcome: SetupFixOutcome }[] {
  const named = new Set(hostChecks(root).map((c) => c.fix).filter((f): f is string => !!f));
  const core = named.has(TAILSCALE_WATCHDOG_FIX) && fixes.includes(TAILSCALE_WATCHDOG_FIX)
    ? [{ id: TAILSCALE_WATCHDOG_FIX, outcome: installTailscaleWatchdog() }] : [];
  return [...core, ...contributedFixes(fixes.filter((f) => named.has(f) && f !== TAILSCALE_WATCHDOG_FIX), root)];
}

/** Run the contributed fixes among `fixes`, in the order they were contributed (not asked). */
export function contributedFixes(fixes: readonly string[], worktree: string): { id: string; outcome: SetupFixOutcome }[] {
  if (!source) return [];
  const out: { id: string; outcome: SetupFixOutcome }[] = [];
  for (const id of source.setupFixIds()) {
    if (!fixes.includes(id)) continue;
    const outcome = source.runSetupFix(id, { worktree });
    if (outcome) out.push({ id, outcome });
  }
  return out;
}
