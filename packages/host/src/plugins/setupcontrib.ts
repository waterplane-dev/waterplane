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

/** Every contributed row for this worktree, in load order. */
export function contributedChecks(worktree: string): ComplianceCheck[] {
  return source ? source.setupChecks({ worktree }) : [];
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
