/**
 * The git half of installing a plugin: which URLs may be cloned at all, and the one place `git` is spawned.
 *
 * The URL comes from a phone, so it is held to a short allowlist BEFORE it reaches argv: `https://`,
 * `ssh://` and `git@host:path`. A leading `-` (an option), `file:` (a local path), `ext::` (runs a
 * command) and every other scheme are refused in words. `git` is `execFile` (no shell), never prompts
 * (`GIT_TERMINAL_PROMPT=0`) and has a timeout. Nothing here touches the plugin registry.
 */
import { execFile } from "node:child_process";
import { compareVersions } from "../cli/selfupdate.js";

/** `git <args>` in `cwd`; resolves stdout, rejects with git's own words. Injected in tests. */
export type Git = (args: string[], cwd?: string) => Promise<string>;

const GIT_TIMEOUT_MS = 120_000;

export const realGit: Git = (args, cwd) => new Promise((resolve, reject) => {
  execFile("git", ["-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=never", ...args], {
    cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 << 20,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", LC_ALL: "C" },
  }, (err, stdout, stderr) => {
    if (!err) return resolve(stdout);
    const said = String(stderr || "").trim().split("\n").filter(Boolean).slice(-2).join(" ");
    reject(new Error((err as NodeJS.ErrnoException & { killed?: boolean }).killed ? `git took longer than ${GIT_TIMEOUT_MS / 1000} s and was stopped` : said || err.message));
  });
});

const HTTPS = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9._~\/+-]+$/;
const SSH = /^ssh:\/\/([A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9._~\/+-]+$/;
const SCP = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~\/+-]+$/;

/** Null when `url` may be cloned; otherwise the refusal, in words. */
export function urlProblem(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return "Name a repository from the list, or paste its https:// or ssh address.";
  const u = url.trim();
  if (u.startsWith("-")) return "That address starts with a dash, which git would read as an option, so it was not used.";
  if (/[\u0000- \u007f]/.test(u)) return "That address has spaces or control characters in it, so it was not used.";
  if (/^file:/i.test(u) || u.startsWith("/") || u.startsWith(".") || u.startsWith("~")) return "A local path or file: address is not accepted; only an https:// or ssh address can be installed from.";
  if (/^ext::/i.test(u)) return "An ext:: address runs a command and is never accepted.";
  if (HTTPS.test(u) || SSH.test(u) || SCP.test(u)) return null;
  return "Only https://, ssh:// and git@host:path addresses can be installed from, and this one is none of them.";
}

/** A branch or tag name safe to hand to git as an argument (never an option, no odd characters). */
export const refOk = (ref: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._\/+-]*$/.test(ref) && !ref.includes("..");

export interface Resolved { kind: "tag" | "branch"; ref: string }

/**
 * What to install from a bare URL: the newest version-numbered tag, else the default branch
 * (`ref: ""`, so the clone takes the remote's HEAD). Throws git's words when the remote cannot be read.
 */
export async function resolveUrl(git: Git, url: string): Promise<Resolved> {
  const out = await git(["ls-remote", "--tags", "--refs", "--", url]);
  const tags = out.split("\n").map((l) => l.split("\t")[1]?.replace(/^refs\/tags\//, "")).filter((t): t is string => !!t && refOk(t));
  let best: string | null = null;
  for (const t of tags) {
    if (!/^v?\d+\.\d+\.\d+/.test(t)) continue;
    if (best === null || compareVersions(best, t) === -1) best = t;
  }
  return best ? { kind: "tag", ref: best } : { kind: "branch", ref: "" };
}
