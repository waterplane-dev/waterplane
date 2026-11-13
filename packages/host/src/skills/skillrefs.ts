/**
 * Which repo files mention a skill or plugin by name (for the Recommend call, P5): names only,
 * never text. The skill's own file is excluded.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const MAX_BYTES = 512 * 1024;

function candidates(wt: string): string[] {
  const out: string[] = [];
  for (const f of ["CLAUDE.md", "CLAUDE.local.md"]) if (existsSync(join(wt, f))) out.push(join(wt, f));
  try {
    for (const d of readdirSync(join(wt, ".claude", "skills"))) {
      const p = join(wt, ".claude", "skills", d, "SKILL.md");
      if (existsSync(p)) out.push(p);
    }
  } catch { /* none */ }
  try {
    for (const f of readdirSync(join(wt, ".claude", "agents"))) if (f.endsWith(".md")) out.push(join(wt, ".claude", "agents", f));
  } catch { /* none */ }
  return out;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** name -> repo-relative files mentioning it at word boundaries. `own` maps a name to the file that IS it. */
export function repoReferences(wt: string, names: readonly string[], own: Readonly<Record<string, string>> = {}): Record<string, string[]> {
  const texts: [string, string][] = [];
  for (const abs of candidates(wt)) {
    try {
      if (statSync(abs).size > MAX_BYTES) continue;
      texts.push([abs, readFileSync(abs, "utf8")]);
    } catch { /* unreadable: absent */ }
  }
  const out: Record<string, string[]> = {};
  for (const name of names) {
    const re = new RegExp(`(?<![A-Za-z0-9_-])${esc(name)}(?![A-Za-z0-9_-])`);
    const hits = texts.filter(([abs, t]) => abs !== own[name] && re.test(t)).map(([abs]) => relative(wt, abs));
    if (hits.length) out[name] = hits;
  }
  return out;
}
