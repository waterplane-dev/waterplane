/**
 * The permissions extension is private: a build whose tree does not hold it bundles this instead
 * (`esbuild.mjs`, `permissions-optional`). It answers nothing, so `permissions-*` rules read "not
 * checked" in the Findings view, never passed.
 */
import type { Finding } from "@waterplane/shared";

export interface PermissionsAsk { worktree: string; userDir: string; read: (path: string) => string | null; now: number }

export function permissionsContribution(_a: PermissionsAsk): { findings: Finding[]; answered: string[] } {
  return { findings: [], answered: [] };
}
