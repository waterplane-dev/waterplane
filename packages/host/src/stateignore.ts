/**
 * Keep the state dir out of a repo's `git status` before this host writes a
 * file there that nobody tapped for (the first health measurement).
 *
 * Most repos ignore the dir already (scaffold, the setup checklist's fix). One
 * that does not gets a line in `.git/info/exclude`: local to this checkout, so
 * the repo has no diff the person did not make — `cloneRepo`'s rule. Never
 * `.gitignore`, which is the repo's own file.
 */
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { BRAND } from "@waterplane/shared";
import { repoStateDir } from "./branddirs.js";

/** `{ code, out }`; a git that could not run at all is code 128. Never rejects. */
function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k]; // a hook's GIT_DIR names another repo
  return new Promise((res) => {
    execFile("git", args, { cwd, env, timeout: 20_000 }, (err, out) => {
      const code = (err as { code?: unknown } | null)?.code;
      res({ code: !err ? 0 : typeof code === "number" ? code : 128, out: String(out ?? "").trim() });
    });
  });
}

/** True when the state dir is ignored here, now or already; false = not a git repo, or the line could not be written. */
export async function ensureStateDirIgnored(wt: string): Promise<boolean> {
  const dir = basename(repoStateDir(wt));
  const probe = join(dir, "repohealth.jsonl");
  const before = await git(wt, ["check-ignore", "-q", "--", probe]);
  if (before.code === 0) return true;
  if (before.code !== 1) return false; // 128: not a repo
  const at = await git(wt, ["rev-parse", "--git-path", "info/exclude"]);
  if (at.code !== 0 || !at.out) return false;
  try {
    const file = resolve(wt, at.out);
    mkdirSync(dirname(file), { recursive: true });
    const have = existsSync(file) ? readFileSync(file, "utf8") : "";
    appendFileSync(file, `${have && !have.endsWith("\n") ? "\n" : ""}# ${BRAND.name}: this desktop's state, local to this clone\n/${dir}/\n`);
  } catch { return false; }
  // A negation in the repo's own .gitignore wins over the exclude file: ask again rather than assume.
  return (await git(wt, ["check-ignore", "-q", "--", probe])).code === 0;
}
