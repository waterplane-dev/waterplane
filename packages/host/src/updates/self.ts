/**
 * What the updates view says about waterplane ITSELF: the install mode, the newest release and,
 * for installs the signed updater cannot drive, the exact command and why there is no button.
 *
 * Only a tarball (install.sh) install gets `canApply`: that is the updater which verifies the
 * publisher's signature and can roll back. npm and checkout installs are told their command.
 * `latestRelease` reads `release.json` under that same signature check; a failure throws, so the
 * caller keeps its previous reading. Nothing here changes the machine.
 */
import { BRAND } from "@waterplane/shared";
import type { SelfUpdateInfo } from "@waterplane/shared";
import { compareVersions, currentMode, installedVersions, latestRelease, releaseSource, rollbackTarget } from "../cli/selfupdate.js";
import type { InstallMode } from "../cli/selfupdate.js";
import { identity } from "../cli/index.js";
import { ghJson } from "./github.js";

export interface SelfDeps {
  mode: () => InstallMode;
  current: () => string;
  /** The newest published version; throws when it cannot be read. */
  latest: () => Promise<string>;
  /** Release notes for `version`, display-only; absent when there are none. Never throws. */
  notes: (version: string) => Promise<string | undefined>;
  installed: (dataDir: string) => string[];
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
};

/** The install-shaped half: mode, current, button or command. Synchronous, offline. */
export function selfBase(deps: SelfDeps = realSelfDeps): SelfUpdateInfo {
  const mode = deps.mode();
  const current = deps.current();
  switch (mode.kind) {
    case "tarball":
      return { mode: "tarball", current, canApply: true, rollbackTo: rollbackTarget(deps.installed(mode.dataDir), mode.version) ?? undefined };
    case "npm":
      return { mode: "npm", current, canApply: false, command: `npm i -g ${BRAND.slug}@latest`, why: "This install came from npm, so npm updates it; the updater that checks the publisher's signature and can roll back only runs for the release tarball install." };
    case "checkout":
      return { mode: "checkout", current, canApply: false, command: "git pull && npm ci && npm run restart", why: "This is a git checkout, so git updates it; the updater that checks the publisher's signature and can roll back only runs for the release tarball install." };
    default:
      return { mode: "unknown", current, canApply: false, why: "This install is not one the updater recognises, so it cannot update it. Reinstall from the release to get updates." };
  }
}

/** The newest release (and notes) when it is newer than what runs; `latest` is set only then. Throws on failure. */
export async function selfLatest(deps: SelfDeps = realSelfDeps): Promise<{ latest: string; notes?: string }> {
  const latest = await deps.latest();
  const cmp = compareVersions(deps.current(), latest);
  return { latest, notes: cmp === -1 ? await deps.notes(latest) : undefined };
}
