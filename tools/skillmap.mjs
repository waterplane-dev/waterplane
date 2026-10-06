/**
 * The router's module map, computed rather than typed.
 *
 * `web` and `host` are routers: their job is to say which sub-skill
 * holds the rules for the module you are about to edit. A map that is written
 * by hand is a map that is wrong the first time a bullet moves, and a wrong
 * map is worse than none — it sends the agent to a skill that does not hold
 * the rule, which reads exactly like "there is no rule here".
 *
 * So the map is derived from the sub-skills themselves: a module belongs to
 * the skill whose bullet HEAD names it. `claudemd.test.mjs` regenerates this
 * and fails if the router has drifted, which makes the map a check instead of
 * a promise.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

/**
 * What a module's name looks like, by extension.
 *
 * The default is `.ts`/`.tsx` and is what `claudemd.test.mjs` gets: this
 * repo's routers name TypeScript modules and nothing else, and the drift
 * check's job is to compare the map against the bullets, not to widen what
 * counts as a bullet. `tools/repohealth/snapshot.mjs` passes the active
 * language packs' extensions instead, so a router in a Kotlin repo that names
 * `PairingService.kt` is read by the same rule — one regex, two callers, and
 * the caller that cares about other languages is the one that knows which.
 *
 * Longest extension first, so `tsx` is tried before `ts`: the alternation
 * would backtrack into the right answer anyway, but only because a backtick
 * follows, and that is a property of the surrounding pattern rather than of
 * the list.
 */
const DEFAULT_MOD_EXTS = Object.freeze([".ts", ".tsx"]);
const MOD_CACHE = new Map();

function modRe(exts) {
  const key = exts.join("|");
  let re = MOD_CACHE.get(key);
  if (!re) {
    const alt = [...exts]
      .map((e) => e.replace(/^\./, ""))
      .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
      .map((e) => e.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    re = new RegExp("`([A-Za-z][A-Za-z0-9_/.]*\\.(?:" + alt + "))`", "g");
    MOD_CACHE.set(key, re);
  }
  return re;
}

/**
 * Modules named in the FIRST line of each bullet — what the bullet is about.
 *
 * @param {string} text
 * @param {readonly string[]} [exts]  Extensions that make a backticked token a
 *   module name. Defaults to `.ts`/`.tsx`; see `DEFAULT_MOD_EXTS`.
 */
export function headModules(text, exts = DEFAULT_MOD_EXTS) {
  const out = new Set();
  if (exts.length === 0) return out;
  const re = modRe(exts);
  for (const l of text.split("\n")) {
    if (!l.startsWith("- ")) continue;
    // A cached global regex carries `lastIndex`; `matchAll` on a global regex
    // clones it internally, but resetting is cheap insurance against a future
    // caller reaching for `exec`.
    re.lastIndex = 0;
    for (const m of l.matchAll(re)) out.add(basename(m[1]));
  }
  return out;
}

/** `{ "web-term": ["Terminal.tsx", ...] }` for one router's sub-skills. */
export function ownership(skillsDir, router) {
  const owned = {};
  for (const name of readdirSync(skillsDir).sort()) {
    if (!name.startsWith(router + "-")) continue;
    let text;
    try { text = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8"); } catch { continue; }
    owned[name] = [...headModules(text)].sort();
  }
  return owned;
}

/** The map as the router must print it: one line per sub-skill. */
export function mapLines(owned) {
  return Object.entries(owned).map(([name, mods]) => `- \`${name}\` — ${mods.join(", ")}`);
}

/**
 * Modules a skill's `description:` names.
 *
 * The description is the ONLY thing an agent reads when choosing a skill, so a
 * module named there is a promise that this skill holds its rules. A promise
 * the map cannot keep — because no bullet HEAD names that module — is the worst
 * of both: the agent loads a 20k body on the strength of the description and
 * the router never points anyone there. `claudemd.test.mjs` holds the two in
 * step, which also closes the repo-health metric's blind spot: a commit is
 * charged for a skill only if a head names the file, so a module that lives in
 * a description alone is loaded for free, forever.
 */
export function descriptionModules(text) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  const desc = fm ? (/^description:\s*(.+)$/m.exec(fm[1])?.[1] ?? "") : "";
  const out = new Set();
  for (const m of desc.matchAll(/\b([A-Za-z][A-Za-z0-9_]*\.(?:ts|tsx))\b/g)) out.add(m[1]);
  return out;
}
