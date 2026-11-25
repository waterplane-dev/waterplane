/**
 * Looking at the cloud with a sign-in that gcloud's own store does not hold: a credential command the
 * person named in `<config dir>/links-signin.json`. Only a person's tap runs it, so a command that
 * asks for a fingerprint asks once per tap. The tokens go to the child it starts
 * (`cloudscan-cli.mts`), never to this daemon. No file: no offer.
 *
 *     { "name": "the keychain", "run": ["some-tool", "exec", "--env", "LINKS_GCLOUD_TOKEN_0=…", "--"] }
 *
 * The command is run with the look appended, and must put an access token in each
 * `LINKS_GCLOUD_TOKEN_<n>` of its environment.
 */
import { readFile } from "node:fs/promises";
import { delimiter, dirname } from "node:path";
import type { CloudScan } from "./cloudscan.mjs";
import { firstLine, type Runner } from "./run.mjs";

export const TOKEN_VAR = "LINKS_GCLOUD_TOKEN_";
/** An approval can take minutes; the rest is the look itself. */
const LOOK_MS = 8 * 60_000;

export interface SignInRoots { run: Runner; signInFile: string; scanCli: string; gcloudBin: string | null; lookCwd: string }
export interface SignIn { name: string; run: string[] }

/** The command, or a sentence saying the file is wrong, or null when there is none. */
export async function loadSignIn(file: string): Promise<SignIn | string | null> {
  let text: string;
  try { text = await readFile(file, "utf8"); } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : `${file} could not be read: ${(e as Error).message}`;
  }
  try {
    const d = JSON.parse(text) as Partial<SignIn> | null;
    const name = typeof d?.name === "string" ? d.name.replace(/\s+/g, " ").trim().slice(0, 40) : "";
    if (name && Array.isArray(d!.run) && d!.run.length && d!.run.every((a) => typeof a === "string" && a)) return { name, run: d!.run };
  } catch { /* said below */ }
  return `${file} needs "name" and "run" (a list of words) — cloud links are not offered with it.`;
}

/** A command that is a `#!/usr/bin/env node` script needs node on launchd's bare PATH; a pane of the
 *  terminal the host was started from is not who asks. */
const childEnv = (): Record<string, string | undefined> => ({ PATH: [dirname(process.execPath), process.env.PATH ?? "/usr/bin:/bin"].join(delimiter), TMUX_PANE: undefined });

/** One look, or the sentence that says why there was none. */
export async function lookWith(r: SignInRoots, s: SignIn): Promise<CloudScan | string> {
  const [bin, ...args] = s.run;
  const out = await r.run(bin!, [...args, process.execPath, r.scanCli, r.gcloudBin ?? "gcloud"], { timeoutMs: LOOK_MS, env: childEnv(), cwd: r.lookCwd });
  if (out.code === 0) {
    try {
      const d = JSON.parse(firstLine(out.stdout)) as CloudScan;
      if (Array.isArray(d.projects) && Array.isArray(d.rows) && Array.isArray(d.notes)) return d;
    } catch { /* said below */ }
    return `The look with ${s.name} answered something that could not be read.`;
  }
  if (out.timedOut) return `The look with ${s.name} took longer than 8 minutes and was stopped.`;
  const said = out.stderr.split("\n").map((l) => l.trim()).filter(Boolean).pop();
  return `Not looked with ${s.name}: ${said || out.error || `exit ${out.code}`}`;
}
