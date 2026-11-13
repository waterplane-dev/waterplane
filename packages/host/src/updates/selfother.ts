/**
 * The update button for the two installs the signed updater (`cli/selfupdate.ts`) does not drive:
 * an npm global install and a git checkout. Run only from `apply.ts`, on a confirmed tap.
 *
 * - npm: `npm i -g --prefix <the prefix this install lives under> <slug>@<the version shown>`. The
 *   version is pinned to what the phone confirmed, never `@latest` at run time.
 * - checkout: refuse in words unless it is on a branch with an upstream, has no tracked changes and no
 *   commits of its own; then `git fetch`, `git merge --ff-only @{u}`, `npm ci`, `npm run build`. A
 *   failure after the merge leaves the old code running (nothing restarts) and says how to go back.
 *
 * Every command is `execFile` (no shell) with a timeout; the words returned are what the phone shows.
 * Restarting is the caller's (`apply.ts`, under the supervisor rule).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { BRAND } from "@waterplane/shared";
import { realGit } from "./gitops.js";
import type { Git } from "./gitops.js";

/** `cmd args` in `cwd`; resolves stdout, rejects with the command's last words. Injected in tests. */
export type Run = (cmd: string, args: string[], cwd: string | undefined, timeoutMs: number) => Promise<string>;

export const realRun: Run = (cmd, args, cwd, timeoutMs) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 16 << 20, env: { ...process.env, CI: "1", npm_config_yes: "true" } }, (err, stdout, stderr) => {
    if (!err) return resolve(stdout);
    const said = String(stderr || stdout || "").trim().split("\n").filter(Boolean).slice(-3).join(" ");
    reject(new Error((err as NodeJS.ErrnoException & { killed?: boolean }).killed ? `${basename(cmd)} took longer than ${Math.round(timeoutMs / 60_000)} min and was stopped` : said || err.message));
  });
});

/** The npm beside the node running this host (launchd's PATH may not have one), else `npm` on PATH. */
export function npmBin(): string {
  const beside = join(dirname(process.execPath), "npm");
  return existsSync(beside) ? beside : "npm";
}

/** The `--prefix` an npm global install at `root` (`…/node_modules/<slug>`) lives under. */
export function npmPrefix(root: string): string {
  const nm = dirname(root); // …/node_modules
  const up = dirname(nm);
  return basename(up) === "lib" ? dirname(up) : up; // unix `<prefix>/lib/node_modules`, windows `<prefix>/node_modules`
}

const INSTALL_MS = 10 * 60_000;
const BUILD_MS = 15 * 60_000;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const msg = (e: unknown): string => {
  let t = e instanceof Error ? e.message : String(e);
  while (t.endsWith(".")) t = t.slice(0, -1);
  return t;
};

export interface OtherResult { ok: boolean; message: string; changed: boolean }

export async function npmUpdate(root: string, version: string, run: Run = realRun): Promise<OtherResult> {
  if (!VERSION.test(version)) return { ok: false, changed: false, message: `"${version}" is not a version npm can be asked for. Check for updates again.` };
  try {
    await run(npmBin(), ["install", "--global", "--prefix", npmPrefix(root), `${BRAND.slug}@${version}`], undefined, INSTALL_MS);
  } catch (e) {
    return { ok: false, changed: false, message: `npm could not install ${BRAND.slug} ${version}: ${msg(e)}. The desktop keeps running the version it has.` };
  }
  return { ok: true, changed: true, message: `installed ${version} with npm` };
}

/** A checkout's commits behind its upstream, after a fetch. Throws git's words (no upstream, offline). */
export async function checkoutBehind(root: string, git: Git = realGit): Promise<{ behind: number; upstream: string }> {
  const upstream = (await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root)).trim();
  await git(["fetch", "--quiet"], root);
  const behind = Number((await git(["rev-list", "--count", "HEAD..@{u}"], root)).trim());
  return { behind: Number.isFinite(behind) ? behind : 0, upstream };
}

export async function checkoutUpdate(root: string, git: Git = realGit, run: Run = realRun): Promise<OtherResult> {
  const no = (message: string): OtherResult => ({ ok: false, changed: false, message: `${message} Nothing was changed.` });
  let branch: string, upstream: string;
  try { branch = (await git(["symbolic-ref", "--short", "-q", "HEAD"], root)).trim(); } catch { branch = ""; }
  if (!branch) return no("The checkout is not on a branch (a detached HEAD), so there is nothing to bring up to date.");
  try { upstream = (await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root)).trim(); } catch {
    return no(`${branch} follows no remote branch, so there is nothing to pull from.`);
  }
  const dirty = (await git(["status", "--porcelain", "--untracked-files=no"], root)).split("\n").filter(Boolean).map((l) => l.slice(3));
  if (dirty.length) {
    return no(`The checkout has uncommitted changes (${dirty.slice(0, 3).join(", ")}${dirty.length > 3 ? `, and ${dirty.length - 3} more` : ""}). Commit them or put them aside on the desktop first.`);
  }
  try { await git(["fetch", "--quiet"], root); } catch (e) { return no(`git could not fetch ${upstream}: ${msg(e)}.`); }
  const [ahead, behind] = (await git(["rev-list", "--left-right", "--count", `HEAD...@{u}`], root)).trim().split(/\s+/).map(Number);
  if (ahead > 0) return no(`${branch} has ${ahead} commit${ahead === 1 ? "" : "s"} not on ${upstream}, so it cannot simply move forward. Push or merge them on the desktop first.`);
  if (!behind) return { ok: true, changed: false, message: `already at the newest commit on ${upstream}` };
  const from = (await git(["rev-parse", "--short", "HEAD"], root)).trim();
  try { await git(["merge", "--ff-only", "@{u}"], root); } catch (e) { return no(`git could not move ${branch} forward: ${msg(e)}.`); }
  const to = (await git(["rev-parse", "--short", "HEAD"], root)).trim();
  const back = ` The desktop keeps running the old code and was not restarted; the checkout is now at ${to} (it was ${from}).`;
  try { await run(npmBin(), ["ci"], root, INSTALL_MS); } catch (e) { return { ok: false, changed: true, message: `Pulled ${behind} commit${behind === 1 ? "" : "s"}, but npm ci failed: ${msg(e)}.${back}` }; }
  try { await run(npmBin(), ["run", "build"], root, BUILD_MS); } catch (e) { return { ok: false, changed: true, message: `Pulled ${behind} commit${behind === 1 ? "" : "s"}, but the build failed: ${msg(e)}.${back}` }; }
  return { ok: true, changed: true, message: `pulled ${behind} commit${behind === 1 ? "" : "s"} from ${upstream} (${from} → ${to}) and rebuilt` };
}
