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
import type { ComplianceCheck, SetupFixOutcome, SetupSubject } from "@waterplane/shared";

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
 * The desktop's checklist: every contributed `scope: "host"` row. No repo is the subject, so the
 * subject is the root the repos are found under.
 */
export function hostChecks(root: string): ComplianceCheck[] {
  return source ? source.setupChecks({ worktree: root }).filter((c) => c.scope === "host") : [];
}

/**
 * Run the fixes among `fixes` that a desktop row names right now — never a repo row's fix, which
 * needs that repo as its subject.
 */
export function hostFixes(fixes: readonly string[], root: string): { id: string; outcome: SetupFixOutcome }[] {
  const named = new Set(hostChecks(root).map((c) => c.fix).filter((f): f is string => !!f));
  return contributedFixes(fixes.filter((f) => named.has(f)), root);
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
