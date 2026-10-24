/**
 * Is a backend's binary there to spawn — and if not, WHY, in a sentence.
 *
 * A package-manager upgrade (`npm i -g @anthropic-ai/claude-code`, `brew upgrade`) unlinks the
 * command for the minutes it takes to unpack the new one. A session started or reopened in that
 * window used to spawn nothing and show tmux's bare `[exited]`. This answers before the spawn:
 * "being updated, start it again when that finishes" when an install of it is running, "not on
 * this desktop" when nothing is.
 *
 * The parse is pure (`installerIn`); the `ps` read is synchronous because `prepare` is, and it
 * runs only on a miss — a binary that resolves costs one PATH scan and no child process.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathHas } from "./claudebin.js";
import { claudeBin, type BackendDescriptor } from "./backends/index.js";

export interface InstallerProc { pid: number; cmd: string }

/** Package-manager verbs that replace an installed command. */
const PM_RE = /(?:^|[\s/])(?:npm|pnpm|yarn|bun|brew|volta)(?:\.\w+)?\s+(?:-g\s+)?(?:install|i|add|update|upgrade|up|reinstall|global\s+add)\b/;

/**
 * The first process in a `ps -axo pid=,command=` dump that is installing `bin`: a package manager
 * whose command line names the binary (`@anthropic-ai/claude-code` names `claude`,
 * `opencode-ai` names `opencode`), or the CLI's own `update`/`install`. Null when none is.
 */
export function installerIn(psText: string, bin: string, selfPid = -1): InstallerProc | null {
  const name = path.basename(bin).replace(/\.(exe|cmd)$/i, "").toLowerCase();
  if (!name) return null;
  for (const raw of psText.split("\n")) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(raw);
    if (!m) continue;
    const pid = Number(m[1]); const cmd = m[2].trim();
    if (pid === selfPid) continue;
    const low = cmd.toLowerCase();
    const viaPm = PM_RE.test(low) && low.includes(name);
    const self = new RegExp(`(?:^|/)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\.exe)?\\s+(?:update|install)\\b`).test(low);
    if (viaPm || self) return { pid, cmd };
  }
  return null;
}

/** An install of `bin` running on this machine right now, or null (also when `ps` cannot be read). */
export function installerRunning(bin: string): InstallerProc | null {
  if (process.platform === "win32") return null;
  try {
    const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 3000, maxBuffer: 8 * 1024 * 1024 });
    return installerIn(out, bin, process.pid);
  } catch { return null; }
}

/** Does `bin` resolve: a path that exists, or a bare name on this process's PATH. */
export function binResolves(bin: string): boolean {
  if (!bin) return false;
  return bin.includes("/") || bin.includes("\\") ? existsSync(bin) : pathHas(bin, process.platform);
}

const short = (cmd: string): string => (cmd.length > 120 ? `${cmd.slice(0, 117)}…` : cmd);

/** The clause for an install in progress — shared by the session refusal and the update button. */
export function installingWords(label: string, p: InstallerProc): string {
  return `${label} is being installed or updated on this desktop right now (\`${short(p.cmd)}\`, pid ${p.pid}) — its command is missing until that finishes`;
}

/**
 * The refusal a session start gets when `label`'s binary is not there, or null when it is.
 * `ownWords`: the backend says its own "not installed" in `prepare` (claude's names the install
 * command and the places it looked), so only the installing case is said here.
 */
export function binMissingRefusal(
  label: string, bin: string,
  facts: { resolves: (b: string) => boolean; installer: (b: string) => InstallerProc | null } = { resolves: binResolves, installer: installerRunning },
  ownWords = false,
): string | null {
  if (facts.resolves(bin)) return null;
  const inst = facts.installer(bin);
  if (inst) return `${installingWords(label, inst)}. Start the session again once it is done.`;
  if (ownWords) return null;
  return `${label} is not installed on this desktop — \`${bin}\` is not on the PATH the host runs with. Install it (or fix that PATH), then start the session again.`;
}

/** `binMissingRefusal` for a backend about to be launched; claude speaks its own "not installed" in `prepare`. */
export function backendBinRefusal(backend: Pick<BackendDescriptor, "label" | "bin">): string | null {
  const bin = backend.bin();
  return binMissingRefusal(backend.label, bin, undefined, bin === claudeBin());
}
