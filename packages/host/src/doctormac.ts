/**
 * The macOS preflight rows that only matter to an account that cannot install
 * things itself — the same two facts the installer's preflight says
 * (`deploy/install.sh.tmpl`), so a person who came in through npm hears them too.
 *
 *  - `git`: every Mac has `/usr/bin/git`, a stand-in that only offers to install
 *    the Xcode Command Line Tools (an administrator's install) until they are
 *    there. "git is on PATH" is true on every Mac and says nothing.
 *  - `mac-admin`: an account outside the `admin` group cannot install Homebrew,
 *    the Command Line Tools or Tailscale, and Homebrew set up by another account
 *    refuses its `brew install`. One row names what to ask an administrator for —
 *    only when something on that list is actually missing.
 *
 * The rows are pure over `MacFacts`; `probeMac` gathers the facts.
 */
import type { Check } from "./doctor.js";
import { run, which } from "./doctorproc.js";
import { tailscaleBin } from "./net.js";
import { brewHere, onPath } from "./tmuxreq.js";

export const MAC_GIT_STUB = "/usr/bin/git";

export interface MacFacts {
  /** `command -v git`, or null. */
  gitPath: string | null;
  /** `xcode-select -p` succeeded: the Command Line Tools (or Xcode) are installed. */
  clt: boolean;
  /** `id -un`. */
  user: string;
  /** `id -Gn`'s output, or null when it could not be run. */
  groups: string | null;
  tmux: boolean;
  /** Where Homebrew lives (its repository), or null when there is no brew. */
  brewRepo: string | null;
  /** This account may write to `brewRepo`. */
  brewWritable: boolean;
  /** The account Homebrew belongs to, or null when unknown. */
  brewOwner: string | null;
  tailscale: boolean;
}

/** In the `admin` group. Unknown (no `id` output) counts as admin: never a row on a guess. */
export function isMacAdmin(groups: string | null): boolean {
  return groups === null || groups.trim().split(/\s+/).includes("admin");
}

/** Homebrew is here and this account can install with it. */
export function brewUsable(f: Pick<MacFacts, "brewRepo" | "brewWritable">): boolean {
  return f.brewRepo !== null && f.brewWritable;
}

/** The `git` row on a Mac: Apple's stand-in without the Command Line Tools is a fail. */
export function macGitCheck(f: Pick<MacFacts, "gitPath" | "clt">): Check {
  if (!f.gitPath) {
    return { id: "git", status: "fail", detail: "git not found", fix: "Install the Xcode Command Line Tools (xcode-select --install) — repo discovery, worktrees and the diff view all shell out to git." };
  }
  if (f.gitPath === MAC_GIT_STUB && !f.clt) {
    return {
      id: "git",
      status: "fail",
      detail: `${MAC_GIT_STUB} is Apple's stand-in: the Xcode Command Line Tools are not installed, so git does not run`,
      fix: "Run: xcode-select --install (needs an administrator) — repo discovery, worktrees and the diff view all shell out to git.",
    };
  }
  return { id: "git", status: "ok", detail: `git present (${f.gitPath})` };
}

/** What this account cannot install itself and is missing, in the order a person asks for it. */
export function macAdminNeeds(f: MacFacts): string[] {
  const needs: string[] = [];
  if (!f.tmux && !brewUsable(f)) needs.push("tmux");
  if (f.gitPath === null || (f.gitPath === MAC_GIT_STUB && !f.clt)) needs.push("the Xcode Command Line Tools");
  if (!f.tailscale) needs.push("Tailscale");
  return needs;
}

/** The `mac-admin` row, or null when this account is an admin or nothing it lacks needs one. */
export function macAdminCheck(f: MacFacts): Check | null {
  if (isMacAdmin(f.groups)) return null;
  const needs = macAdminNeeds(f);
  if (needs.length === 0) return null;
  const brewNote = !f.tmux && f.brewRepo !== null && !f.brewWritable
    ? ` Homebrew here belongs to ${f.brewOwner ?? "another account"}, so brew install tmux fails for this one — that account can run it.`
    : "";
  return {
    id: "mac-admin",
    status: "warn",
    detail: `this account (${f.user}) is not an administrator of this Mac, so it cannot install ${needs.join(", ")} itself`,
    fix: `Ask whoever administers this Mac for: ${needs.join(", ")}.${brewNote}`,
  };
}

/** The live facts. macOS only — the caller asks on darwin. */
export async function probeMac(): Promise<MacFacts> {
  const [gitPath, clt, user, groups, ts] = await Promise.all([
    which("git"),
    run("xcode-select", ["-p"], 4000),
    run("id", ["-un"], 4000),
    run("id", ["-Gn"], 4000),
    tailscaleBin(),
  ]);
  const brew = brewHere();
  const brewRepo = brew?.repo ?? null;
  const brewWritable = brew?.writable === true;
  const owner = brewRepo && !brewWritable ? await run("stat", ["-f", "%Su", brewRepo], 4000) : null;
  return {
    gitPath,
    clt: clt.ok,
    user: user.ok ? user.out : "this account",
    groups: groups.ok ? groups.out : null,
    tmux: onPath("tmux") !== null,
    brewRepo,
    brewWritable,
    brewOwner: owner?.ok && owner.out ? owner.out : null,
    tailscale: ts !== null,
  };
}
