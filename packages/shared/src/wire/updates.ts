/**
 * The updates view's DTOs: waterplane itself plus plugins from the waterplane org.
 * Mirrors `UpdateInfo` (wire/repo.ts) for naming. Every optional field absent means the
 * host did not say — never a guess. Nothing here applies itself: a check is a read.
 */

import type { PluginMaturityLevel } from "../pluginmaturity.js";

export type SelfUpdateMode = "tarball" | "npm" | "checkout" | "unknown";

/** What a plugin is installed as. `local` = put there by hand: shown, never updated by the manager. */
export interface InstalledPlugin {
  id: string;
  version: string;
  source: "manager" | "local";
  /** The tag or branch the manager cloned. Absent on `local`. */
  ref?: string;
  commit?: string;
  dir: string;
}

export interface CatalogLatest {
  kind: "tag" | "branch";
  ref: string;
  commit?: string;
  /** Release notes, display-only. */
  notes?: string;
}

export interface CatalogEntry {
  /** `owner/name` on GitHub. */
  repo: string;
  url: string;
  name: string;
  description: string;
  maturity: PluginMaturityLevel;
  /** null = nothing installable was found; see `problems`. */
  latest: CatalogLatest | null;
  installed: InstalledPlugin | null;
  /**
   * True only when `url` is on github.com under the `BRAND.githubOrg` org (judged by URL host plus
   * org, never by the `repo` label). "from waterplane-dev" is shown only when this is true.
   */
  fromOrg: boolean;
  /** Refusals in words: no manifest, has dependencies, apiVersion too new, id clash. */
  problems: string[];
}

export interface SelfUpdateInfo {
  mode: SelfUpdateMode;
  current: string;
  latest?: string;
  notes?: string;
  /**
   * True when the update button can run: a tarball install (the signed updater), an npm install
   * (`npm i -g` of the shown version) or a git checkout (fast-forward, `npm ci`, build). False = no
   * button, and `why` says so.
   */
  canApply: boolean;
  /** The command the button runs (npm/checkout), shown so a person can run it by hand instead. */
  command?: string;
  /** Why there is no button, in words (only when `canApply` is false). */
  why?: string;
  /** What the npm/checkout button does NOT do that the tarball updater does (no signature check, no roll back). */
  caveat?: string;
  /** A checkout only: commits on `upstream` not in HEAD, as of the last check; absent = not read. */
  behind?: number;
  /** A checkout only: the branch it follows, e.g. `origin/main`. */
  upstream?: string;
  /** The version a roll-back would return to. */
  rollbackTo?: string;
  /** Receipt of the last apply/rollback, verbatim, kept across a restart. */
  lastResult?: { ok: boolean; message: string; at: number };
}

export interface UpdatesStatus {
  self: SelfUpdateInfo;
  catalog: CatalogEntry[];
  /** ms since epoch of the last check; absent = never checked. */
  checkedAt?: number;
  /** The last check's failure as a sentence. */
  error?: string;
  autoCheck: boolean;
  /** ms since epoch before which "check now" answers from the cache (10 min after an ok check, 30 s after a failed one); absent = a check is allowed now. */
  nextCheckAt?: number;
  /** The last apply (install, update, self, restart), verbatim; absent = none yet. */
  lastApply?: UpdatesLastApply;
}

export type UpdatesTarget =
  | { kind: "self" }
  | { kind: "self-rollback" }
  | { kind: "plugin-install"; repo?: string; url?: string }
  | { kind: "plugin-update"; id: string }
  /** Restart this desktop's host (after a plugin update). Refused in words when nothing would start it again. */
  | { kind: "restart" };

/**
 * What an apply leaves to do.
 *  - `restarting`: the host is restarting ITSELF now (self update, self rollback, the restart target);
 *    the link drops and comes back.
 *  - `offer`: a plugin update that needs a restart the host can do on request (`{kind:"restart"}`).
 *  - `manual`: a person must restart the desktop (nothing supervises it).
 *  - `none`: nothing to restart.
 */
export type UpdatesRestart = "restarting" | "offer" | "manual" | "none";

/** The last apply of any kind, kept across a dropped link and a restart: what a reconnecting phone reads. */
export interface UpdatesLastApply {
  target: UpdatesTarget;
  ok: boolean;
  message: string;
  restart: UpdatesRestart;
  at: number;
}

/** One row of the updates view that counts as "an update". */
export type UpdateDue =
  | { kind: "self"; current: string; latest: string }
  | { kind: "plugin"; id: string; repo: string; from: string | undefined; to: string };

function ver(s: string | undefined): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(s ?? "");
  return m ? [+m[1], +m[2], +m[3]] : null;
}

/** True only when `b` is known to be newer than `a`; unparseable versions are never "newer". */
export function newerVersion(a: string, b: string): boolean {
  const x = ver(a), y = ver(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] > x[i];
  return false;
}

/** "3 new commits on origin/main": what stands where a version would for a checkout. */
export function checkoutLatestWords(behind: number, upstream: string | undefined): string {
  return `${behind} new commit${behind === 1 ? "" : "s"}${upstream ? ` on ${upstream}` : ""}`;
}

/**
 * THE bucketing function: which rows count as "an update". The count on the control and the list it
 * opens both come from this, never two copies of the edge.
 *  - self: `latest` newer than `current` AND (the button can apply it OR a command is given); a
 *    checkout instead when its last check saw commits on its upstream (`behind` > 0);
 *  - plugin: manager-installed only (`local` is managed by the person), with a newer tag, or a
 *    branch whose head commit is known on both sides and differs.
 */
export function updatesDue(status: Pick<UpdatesStatus, "self" | "catalog"> | null | undefined): UpdateDue[] {
  const out: UpdateDue[] = [];
  if (!status) return out;
  const s = status.self;
  if (s.mode === "checkout") {
    // A checkout follows its branch, not the release: due when the last check saw new commits on it.
    if (s.behind && s.behind > 0) out.push({ kind: "self", current: s.current, latest: checkoutLatestWords(s.behind, s.upstream) });
  } else if (s.latest && newerVersion(s.current, s.latest) && (s.canApply || !!s.command)) {
    out.push({ kind: "self", current: s.current, latest: s.latest });
  }
  for (const e of status.catalog) {
    const i = e.installed, l = e.latest;
    if (!i || !l || i.source !== "manager" || e.problems.length > 0) continue;
    let newer: boolean;
    if (l.kind === "tag") {
      const a = ver(i.ref), b = ver(l.ref);
      newer = !!i.ref && l.ref !== i.ref && (a && b ? newerVersion(i.ref, l.ref) : true);
    } else {
      newer = !!l.commit && !!i.commit && l.commit !== i.commit;
    }
    if (newer) out.push({ kind: "plugin", id: i.id, repo: e.repo, from: i.ref, to: l.ref });
  }
  return out;
}
