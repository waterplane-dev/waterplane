// The exposure watch's list of repos: `<stateDir>/exposure/targets.json`, appended to from the phone and
// read by the daily runner. Pure parts only (the CLI does the I/O). A missing or unreadable file is
// "no targets"; a bad entry is skipped with a sentence, never guessed at.
import { isAbsolute } from "node:path";

export const TARGET_NAME = /^[a-z0-9][a-z0-9._-]*$/;
export const GH_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

/** `{ targets, problems }` from the parsed file: valid entries in order, one sentence per skipped one. */
export function parseTargets(doc) {
  const problems = [], targets = [], seen = new Set();
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !Array.isArray(doc.targets)) return { targets, problems: ["targets.json has no `targets` list"] };
  doc.targets.forEach((t, i) => {
    const at = `target #${i + 1}${typeof t?.name === "string" ? ` (${t.name})` : ""}`;
    if (!t || typeof t !== "object" || Array.isArray(t)) return void problems.push(`${at}: not an object`);
    if (typeof t.name !== "string" || !TARGET_NAME.test(t.name)) return void problems.push(`${at}: name must be [a-z0-9._-]`);
    if (seen.has(t.name)) return void problems.push(`${at}: duplicate name`);
    if (typeof t.dir !== "string" || !isAbsolute(t.dir)) return void problems.push(`${at}: dir must be an absolute path`);
    if (t.gh !== undefined && (typeof t.gh !== "string" || !GH_SLUG.test(t.gh))) return void problems.push(`${at}: gh must be owner/repo`);
    if (t.args !== undefined && (!Array.isArray(t.args) || t.args.some((a) => typeof a !== "string"))) return void problems.push(`${at}: args must be a list of strings`);
    seen.add(t.name);
    targets.push({ name: t.name, dir: t.dir, ...(t.gh ? { gh: t.gh } : {}), play: t.play === true, args: t.args ?? [] });
  });
  return { targets, problems };
}

/** The `run` argv for one target. `{HOME}` / `{SITE}` in args are expanded from `vars`; --npm-2fa-confirmed is added when the target publishes to npm and the runner knows the date. */
export function targetRunArgv(t, vars, extra = []) {
  const sub = (a) => a.replace(/\{(HOME|SITE)\}/g, (_, k) => vars[k] ?? "");
  const argv = [t.dir, "--name", t.name, ...(t.gh ? ["--gh", t.gh] : []), ...t.args.map(sub)];
  if (t.args.includes("--npm") && vars.NPM_2FA_CONFIRMED && !t.args.includes("--npm-2fa-confirmed")) argv.push("--npm-2fa-confirmed", vars.NPM_2FA_CONFIRMED);
  return [...argv, ...extra];
}

/** The `{HOME}`/`{SITE}` placeholders a target's args use while `vars` holds nothing for them. A target run
 *  with one empty would check a URL like "/privacy.html" — a wrong reading, worse than none — so the CLI
 *  refuses (exit 64) with `unsetVarsSentence` instead. */
export function unsetTargetVars(t, vars) {
  const used = new Set();
  for (const a of t.args ?? []) for (const m of a.matchAll(/\{(HOME|SITE)\}/g)) used.add(m[1]);
  return [...used].filter((k) => !vars[k]);
}

const VAR_ENV = { SITE: "EXPOSURE_SITE", HOME: "HOME" };
export function unsetVarsSentence(t, missing) {
  return `target ${t.name} uses ${missing.map((k) => `{${k}}`).join(" and ")} but ${missing.map((k) => VAR_ENV[k]).join(" and ")} is empty here: not run, because a check against a half-built address would be a wrong reading. Set it (the daily runner's env file) and run again.`;
}
