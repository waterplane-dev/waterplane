/**
 * What the updates view says about waterplane ITSELF: the install mode, the newest release and
 * whether the update button can run, with the command it runs (or why there is none).
 *
 * A tarball (install.sh) install gets the signed updater, which verifies the publisher's signature
 * and can roll back. An npm install's button runs `npm i -g` of the shown version; a checkout's
 * fast-forwards to its upstream and rebuilds (`selfother.ts`) — both say what they skip (`caveat`).
 * `latestRelease` reads `release.json` under the signature check; a failure throws, so the caller
 * keeps its previous reading. Nothing here changes the machine; a checkout's check runs `git fetch`.
 */
import { BRAND } from "@waterplane/shared";
import type { SelfUpdateInfo } from "@waterplane/shared";
import { compareVersions, currentMode, installedVersions, latestRelease, releaseSource, rollbackTarget } from "../cli/selfupdate.js";
import type { InstallMode } from "../cli/selfupdate.js";
import { identity } from "../cli/index.js";
import { ghJson } from "./github.js";
import { checkoutBehind } from "./selfother.js";

export interface SelfDeps {
  mode: () => InstallMode;
  current: () => string;
  /** The newest published version; throws when it cannot be read. */
  latest: () => Promise<string>;
  /** Release notes for `version`, display-only; absent when there are none. Never throws. */
  notes: (version: string) => Promise<string | undefined>;
  installed: (dataDir: string) => string[];
  /** A checkout's commits behind its upstream (after a fetch); throws git's words. */
  behind?: (root: string) => Promise<{ behind: number; upstream: string }>;
}

async function githubNotes(version: string): Promise<string | undefined> {
  try {
    const rel = await ghJson<{ tag_name?: string; body?: string | null }>(`/repos/${BRAND.githubOrg}/${BRAND.slug}/releases/latest`);
    return rel.tag_name?.replace(/^v/, "") === version && rel.body ? rel.body : undefined;
  } catch {
    return undefined; // notes are display-only: a miss is no notes, not a failed check
  }
}

export const realSelfDeps: SelfDeps = {
  mode: currentMode,
  current: () => identity().version,
  latest: async () => (await latestRelease(releaseSource(null))).version,
  notes: githubNotes,
  installed: installedVersions,
  behind: checkoutBehind,
};

/** The install-shaped half: mode, current, button or command. Synchronous, offline. */
export function selfBase(deps: SelfDeps = realSelfDeps): SelfUpdateInfo {
  const mode = deps.mode();
  const current = deps.current();
  switch (mode.kind) {
    case "tarball":
      return { mode: "tarball", current, canApply: true, rollbackTo: rollbackTarget(deps.installed(mode.dataDir), mode.version) ?? undefined };
    case "npm":
      return { mode: "npm", current, canApply: true, command: `npm i -g ${BRAND.slug}@latest`, caveat: "npm checks the package's integrity, not the publisher's signature as the install.sh updater does, and there is no roll back: going back means installing the older version the same way." };
    case "checkout":
      return { mode: "checkout", current, canApply: true, command: "git pull --ff-only && npm ci && npm run restart", caveat: "This updates the git checkout to its branch's newest commits: no signature check and no roll back. It refuses when the checkout has changes or commits of its own." };
    default:
      return { mode: "unknown", current, canApply: false, why: "This install is not one the updater recognises, so it cannot update it. Reinstall from the release to get updates." };
  }
}

/**
 * The newest release (and notes) when it is newer than what runs; `latest` is set only then. A
 * checkout also reads how far it is behind its upstream (a `git fetch`); that part failing leaves it
 * absent rather than failing the release read. Throws when the release cannot be read.
 */
export async function selfLatest(deps: SelfDeps = realSelfDeps): Promise<{ latest: string; notes?: string; behind?: number; upstream?: string }> {
  const latest = await deps.latest();
  const cmp = compareVersions(deps.current(), latest);
  const out: { latest: string; notes?: string; behind?: number; upstream?: string } = { latest, notes: cmp === -1 ? await deps.notes(latest) : undefined };
  const mode = deps.mode();
  if (mode.kind === "checkout" && deps.behind) {
    try { Object.assign(out, await deps.behind(mode.root)); } catch { /* absent: the row says nothing about commits */ }
  }
  return out;
}
