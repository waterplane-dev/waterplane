declare module "permissions-engine" {
  import type { Finding } from "@waterplane/shared";
  export interface PermissionsAsk { worktree: string; userDir: string; read: (path: string) => string | null; now: number }
  export function permissionsContribution(a: PermissionsAsk): { findings: Finding[]; answered: string[] };
}
