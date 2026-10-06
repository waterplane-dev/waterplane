/**
 * Auto-download: the inbox in reverse.
 *
 * The phone can push images INTO a repo, and the gallery can pull one back out
 * when you tap it. What was missing is the case that matters on a bad link: an
 * agent drops a 90 MB APK (or a report) into the outbox while the phone is in a
 * tunnel, and by the time you look, tapping "download" starts a fresh transfer
 * that a passing dead spot kills at 80%. This module is the rule engine for
 * "start pulling it the moment it exists, and keep the byte offset so a resume
 * costs only what's left".
 *
 * Two halves, deliberately split:
 *  - the RULE, per repo, in <repoDir>/<state dir>/autopull.json (next to builds.json),
 *    because what's worth auto-pulling is a property of the project;
 *  - the QUEUE, host-wide, in <STATE_DIR>/pulls.json, because the file usually
 *    lands while nothing is connected. A broadcast at detection time only ever
 *    reaches a phone that happens to be online; the queue is what the phone reads
 *    when it comes back. It is persisted for the same reason the ack ledger is —
 *    `npm run restart` is routine, and a queue that a restart empties is a queue
 *    that silently drops exactly the pull you were waiting for.
 *
 * What is NOT tracked here: whether a device already has the file. Several phones
 * can subscribe to the same host, so "done" is per-device client state
 * (web/pull.ts). The host's job ends at "this file is worth having".
 */
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_AUTOPULL, familyKey, type AutoPullConfig, type PullItem } from "@waterplane/shared";
import { hostStateDir, repoStateDir } from "./branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

/** Re-exported where it was born: the rule moved to `@waterplane/shared` when the
 *  post-build prune started asking the same question ("is this an older build
 *  of the thing I just made?"), and two answers to it would mean the phone
 *  de-duplicating one way while the desktop deletes another. */
export { familyKey };

/** Queue cap. Newest-first; the tail is dropped. */
const MAX_ITEMS = 200;
/** Items older than this are dropped on load — a fortnight-old APK is not worth pulling. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Hard ceiling on a configured size cap (8 GB) so a fat-fingered number stays sane. */
const MAX_CAP = 8 * 1024 * 1024 * 1024;

/** Sanitize a persisted/phone-supplied rule (defensive against a hand-edited file). */
export function cleanConfig(v: any): AutoPullConfig {
  const raw = v && typeof v === "object" ? v : {};
  const match = Array.isArray(raw.match)
    ? raw.match.map((p: any) => String(p).trim()).filter(Boolean).slice(0, 40)
    : [];
  const maxBytes = Number(raw.maxBytes);
  return {
    enabled: !!raw.enabled,
    scope: raw.scope === "repo" ? "repo" : "outbox",
    match,
    maxBytes: Number.isFinite(maxBytes) && maxBytes >= 0 ? Math.min(maxBytes, MAX_CAP) : DEFAULT_AUTOPULL.maxBytes,
    builds: raw.builds !== false,
    supersede: raw.supersede !== false,
  };
}

/**
 * Glob-ish pattern to RegExp. `*` and `?` only — deliberately not a real glob
 * library: the patterns are typed on a phone keyboard ("*.apk", "report-*.md"),
 * and every other metacharacter is escaped so a stray `(` can't throw.
 */
function toRegExp(pattern: string): RegExp {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "i");
}

/**
 * Does this file match the rule? A pattern with a slash is matched against the
 * repo-relative path (`.claude/outbox/*.zip`), one without against the bare name
 * — otherwise "*.apk" would never match, since every candidate is nested.
 */
export function matches(cfg: AutoPullConfig, file: { name: string; relPath: string; size: number }): boolean {
  if (!cfg.enabled) return false;
  if (cfg.maxBytes > 0 && file.size > cfg.maxBytes) return false;
  if (!cfg.match.length) return true;
  return cfg.match.some((p) => toRegExp(p).test(p.includes("/") ? file.relPath : file.name));
}

/** Stable id: the same file re-detected (a second turn, a host restart, a
 *  re-scan) must be the same queue entry, or the phone downloads it twice. The
 *  mtime is in the key on purpose — a REGENERATED file at the same path is a new
 *  thing to fetch, exactly like the gallery's read marks treat it. */
export function pullId(repoId: string, relPath: string, mtime: number): string {
  return "p_" + createHash("sha1").update(`${repoId} ${relPath} ${Math.round(mtime)}`).digest("hex").slice(0, 16);
}

export interface PullCandidate {
  name: string;
  relPath: string;
  size: number;
  mtime: number;
}

/** Catch-up: how far back a rule that was just switched ON looks, and how many
 *  artifacts it may queue from what is already on disk. */
export const CATCHUP_AGE_MS = 24 * 60 * 60 * 1000;
export const CATCHUP_MAX = 3;

/**
 * What a rule that was just turned ON should fetch from what is ALREADY here.
 *
 * Auto-download is a DETECTOR everywhere else: the turn-end scan diffs the
 * scope and a finished build hands over what it produced, so both only ever see
 * a file that appears AFTER the rule exists. Measured here: the rule for
 * picture-app was saved at 10:43 and the 227 MB APK it was saved FOR finished
 * at 10:42 — one minute earlier, so nothing was ever queued, silently, and the
 * switch looked broken. The file a person is looking at when they turn the
 * switch on is precisely the file they mean.
 *
 * Bounded, because the same argument does not extend to a year of artifacts:
 * the NEWEST of each family only (two builds of one app are one thing to
 * fetch, `familyKey`), at most `max` of them, and nothing older than a day.
 * Whether any of them MATCHES the rule is still `matches`' decision — this
 * only picks which candidates are worth asking about.
 */
export function catchUpCandidates<T extends PullCandidate>(
  files: T[],
  now: number = Date.now(),
  maxAgeMs: number = CATCHUP_AGE_MS,
  max: number = CATCHUP_MAX,
): T[] {
  const newest = new Map<string, T>();
  for (const f of files) {
    if (now - f.mtime > maxAgeMs) continue;
    const key = familyKey(f.relPath);
    const cur = newest.get(key);
    if (!cur || f.mtime > cur.mtime) newest.set(key, f);
  }
  return [...newest.values()].sort((a, b) => b.mtime - a.mtime).slice(0, Math.max(0, max));
}

export class AutoPullManager extends EventEmitter {
  private items: PullItem[] = [];
  private queuePath: string;

  constructor(root: string) {
    super();
    this.queuePath = join(hostStateDir(root), "pulls.json");
    try {
      const arr = readJsonGuarded<any>(this.queuePath, null);
      if (Array.isArray(arr)) {
        const cutoff = Date.now() - MAX_AGE_MS;
        this.items = arr
          .filter((i: any) => i && typeof i.id === "string" && typeof i.relPath === "string" && Number(i.ts) > cutoff)
          // The family is RE-DERIVED on load rather than trusted from the file.
          // It is a pure function of the path, so this changes nothing except in
          // the one case that matters: the rule itself has been corrected since
          // the row was written, and a row still carrying the old key would be
          // superseded by nothing for as long as it sat in the queue.
          .map((i: any) => ({ ...i, family: familyKey(i.relPath) }));
      }
    } catch { /* no file / bad json → empty queue, same as a fresh host */ }
  }

  private configPath(repoDir: string): string { return join(repoStateDir(repoDir), "autopull.json"); }

  /** A repo's rule (defaults when there is no file). */
  config(repoDir: string): AutoPullConfig {
    try {
      return cleanConfig(JSON.parse(readFileSync(this.configPath(repoDir), "utf8")));
    } catch {
      return { ...DEFAULT_AUTOPULL };
    }
  }

  /** Persist a repo's rule; returns what was actually written. */
  saveConfig(repoDir: string, cfg: AutoPullConfig): AutoPullConfig {
    const clean = cleanConfig(cfg);
    try {
      const path = this.configPath(repoDir);
      mkdirSync(dirname(path), { recursive: true });
      writeJsonAtomic(path, clean, { space: 2 });
    } catch { /* best-effort — an unwritable repo just doesn't remember the rule */ }
    return clean;
  }

  list(): PullItem[] { return this.items; }

  /**
   * Offer newly-seen files to a repo's rule. Returns the ones that were queued
   * (already-queued ids are dropped silently — the caller's "new file" detection
   * and ours are independent, and a re-offer must not re-queue).
   *
   * `source: "manual"` bypasses the rule entirely: that is the gallery's "send
   * this to my phone" button, an explicit human decision, and gating it on a
   * configured pattern would make the button silently do nothing.
   */
  consider(
    repo: { repoId: string; repoDir: string; repoName: string },
    files: PullCandidate[],
    source: PullItem["source"],
  ): PullItem[] {
    if (!files.length) return [];
    const cfg = source === "manual" ? null : this.config(repo.repoDir);
    // Read the rule even for a manual add: "keep only the newest" is a property
    // of the project, not of how this particular file got queued.
    const supersede = (cfg ?? this.config(repo.repoDir)).supersede;
    if (cfg && !cfg.enabled) return [];
    if (cfg && source === "build" && !cfg.builds) return [];

    const queued: PullItem[] = [];
    for (const f of files) {
      if (cfg && !matches(cfg, f)) continue;
      const id = pullId(repo.repoId, f.relPath, f.mtime);
      if (this.items.some((i) => i.id === id)) continue;
      const item: PullItem = {
        id,
        repoId: repo.repoId,
        repoDir: repo.repoDir,
        repoName: repo.repoName,
        name: f.name,
        relPath: f.relPath,
        size: f.size,
        mtime: f.mtime,
        ts: Date.now(),
        source,
        family: familyKey(f.relPath),
      };
      if (supersede) {
        // Strictly OLDER only. Two files written in the same second are not
        // evidence that one replaces the other, and dropping one of them would
        // silently lose an artifact a build legitimately produced twice.
        const stale = this.items.filter(
          (i) => i.repoId === item.repoId && (i.family ?? familyKey(i.relPath)) === item.family && i.mtime < item.mtime,
        );
        if (stale.length) {
          const drop = new Set(stale.map((i) => i.id));
          this.items = this.items.filter((i) => !drop.has(i.id));
          item.supersedes = stale.map((i) => i.id);
        }
      }
      this.items.unshift(item);
      queued.push(item);
    }
    if (!queued.length) return [];
    if (this.items.length > MAX_ITEMS) this.items.length = MAX_ITEMS;
    this.save();
    for (const item of queued) this.emit("item", item);
    return queued;
  }

  /** Drop one item, or the whole queue when `id` is omitted. */
  dismiss(id?: string): void {
    if (id) this.items = this.items.filter((i) => i.id !== id);
    else this.items = [];
    this.save();
  }

  /** tmp+rename so a kill mid-write can't leave truncated JSON that the
   *  constructor's catch turns into an empty queue. */
  private save(): void {
    try {
      mkdirSync(dirname(this.queuePath), { recursive: true });
      writeJsonAtomic(this.queuePath, this.items, { space: 2 });
    } catch { /* best-effort — in-memory queue still works for this boot */ }
  }
}
