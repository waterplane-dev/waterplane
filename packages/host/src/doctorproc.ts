/**
 * The two process helpers the preflight shares across its halves (`doctor.ts`,
 * `doctorclaude.ts`): a short-leash run that never throws, and a `command -v`
 * that survives a held-up event loop.
 */

import { existsSync } from "node:fs";
import { onPath } from "./tmuxreq.js";
import { execFileP } from "./proc.js";

/** Run `cmd args…` with a short leash; never throws. */
export async function run(cmd: string, args: string[], timeout = 8000): Promise<{ out: string; ok: boolean }> {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { timeout, encoding: "utf8" });
    return { out: `${stdout}${stderr}`.trim(), ok: true };
  } catch (err: any) {
    return { out: String(err?.stdout ?? "" ) + String(err?.stderr ?? err?.message ?? err), ok: false };
  }
}

const WHICH_TIMEOUT_MS = 8000;

export async function which(bin: string): Promise<string | null> {
  // An absolute/relative path (WATERPLANE_CLAUDE_BIN often is one) isn't on PATH.
  if (bin.includes("/")) return existsSync(bin) ? bin : null;
  const began = Date.now();
  const { out, ok } = await run("/bin/sh", ["-c", 'command -v -- "$1"', "sh", bin], WHICH_TIMEOUT_MS);
  if (ok && out) return out.split("\n")[0].trim();
  // An answer that took the whole leash is no answer: with the event loop held up (WSL reading a
  // Windows drive), the timer fires on an exited child and its stdout comes back EMPTY, which read
  // as "not found" for a claude, git and curl that were all there. Ask the PATH directly instead —
  // a file scan, no timer to lose against.
  if (Date.now() - began >= WHICH_TIMEOUT_MS * 0.9) return onPath(bin);
  return null;
}
