/** Which forge serves a worktree. Only GitHub exists; see docs/notes/forge.md for how another is contributed. */
import { ghOfRemote } from "../exposurewatch.js";
import { execFileP } from "../proc.js";
import { githubForge } from "./github.js";
import type { Forge } from "./types.js";

export type { Forge, MergeMethod, ForgeRulesRaw } from "./types.js";
export { githubForge } from "./github.js";

let override: Forge | null = null;
/** Test seam: serve every worktree with this forge (null restores). */
export function setForge(f: Forge | null): void { override = f; }
export const forgeOverride = (): Forge | null => override;

/** The forge for this worktree's origin, or undefined (no origin, or not a forge we speak) — callers treat that as absent. */
export async function forgeFor(wt: string): Promise<Forge | undefined> {
  if (override) return override;
  let slug: string | undefined;
  try {
    const { stdout } = await execFileP("git", ["remote", "get-url", "origin"], { cwd: wt, timeout: 3000 });
    slug = ghOfRemote(stdout);
  } catch { return undefined; }
  return slug ? githubForge(wt, slug) : undefined;
}

/**
 * For the user-initiated PR flow, which has always run `gh` without first asking
 * what origin is (gh resolves the repo itself, and a remote it cannot serve fails
 * with its own sentence): the matching forge, else gh from the worktree.
 */
export async function forgeOrGh(wt: string): Promise<Forge> {
  return (await forgeFor(wt)) ?? githubForge(wt);
}
