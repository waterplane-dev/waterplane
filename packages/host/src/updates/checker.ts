/**
 * The update check: waterplane itself + the plugin catalogue, cached and broadcast.
 *
 * Mirrors `UpdateChecker` (`../update.ts`) in shape: a timer, a cached reading, `onChange`. Differences
 * that matter: the daily timer starts minutes AFTER boot (never in the boot preflight), an on-demand
 * check has a 10-minute floor (the API allows 60 unauthenticated calls an hour), and a FAILED check
 * keeps the previous catalogue and says why in a sentence — `checkedAt` is always the last GOOD check.
 *
 * `status()` re-joins "installed" on every read, so a plugin installed a second ago shows as such
 * without another network call. Nothing here applies anything (CLAUDE.md: nothing applies itself).
 */
import { join } from "node:path";
import { BRAND, envName } from "@waterplane/shared";
import type { CatalogEntry, CatalogLatest, UpdatesLastApply, UpdatesStatus } from "@waterplane/shared";
import { env } from "../env.js";
import { readJsonGuarded, writeJsonAtomic } from "../jsonstore.js";
import { fetchCatalog, joinInstalled } from "./catalog.js";
import type { RawCatalogEntry } from "./catalog.js";
import { GithubError } from "./github.js";
import type { InstalledWithUrl } from "./installrecord.js";
import { isOrgUrl, remoteLatest, repoLabel } from "./remote.js";
import { realSelfDeps, selfBase, selfLatest } from "./self.js";
import type { SelfDeps } from "./self.js";

export const CHECK_FLOOR_MS = 10 * 60_000;
/** After a FAILED attempt the floor is short: a person who fixed their network and taps "check now" gets a real check. */
export const CHECK_FLOOR_FAILED_MS = 30_000;
export const CHECK_EVERY_MS = 24 * 3_600_000;
export const FIRST_CHECK_DELAY_MS = 5 * 60_000;
export const UPDATES_FILE = "updates.json";

interface Cache {
  checkedAt?: number;
  attemptedAt?: number;
  error?: string;
  raw: RawCatalogEntry[];
  self?: { latest: string; notes?: string };
  /** Newest at each URL-installed repo outside the org catalogue (or why it could not be read). */
  remote?: Record<string, { latest: CatalogLatest | null; problem?: string }>;
  lastResult?: { ok: boolean; message: string; at: number };
  /** The last apply of any kind (plugin results included), for a phone whose link dropped. */
  lastApply?: UpdatesLastApply;
}

export interface CheckerDeps {
  /** `hostStateDir(root)`: the cache lives at `<stateDir>/updates.json`. */
  stateDir: string;
  installed: () => InstalledWithUrl[];
  /** The synced `updates.autoCheck` setting (default on). */
  autoCheck: () => boolean;
  onChange: (status: UpdatesStatus) => void;
  /** `prev` = the cached catalogue, so an unchanged release is not re-read. */
  fetchCatalog?: (prev: readonly RawCatalogEntry[]) => Promise<RawCatalogEntry[]>;
  /** Newest at a repo outside the org catalogue; default `remote.ts`. */
  remoteLatest?: (url: string) => Promise<CatalogLatest>;
  self?: SelfDeps;
  now?: () => number;
  firstDelayMs?: number;
}

export const OFF_SENTENCE = `Update checks are switched off on this desktop (${envName("UPDATE_CHECK")}=0).`;

/** `WATERPLANE_UPDATE_CHECK=0` forces every check off, the daily one and a tap alike. */
export const checkForcedOff = (): boolean => { const v = env("UPDATE_CHECK"); return v === "0" || v === "false" || v === "off"; };

/** The synced setting's stored string → on/off; anything unreadable is the default, on. */
export function autoCheckFrom(raw: unknown): boolean {
  return !(raw === "false" || raw === "0" || raw === "off");
}

export class UpdatesChecker {
  private cache: Cache;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly path: string;
  private readonly self: SelfDeps;
  private readonly now: () => number;

  constructor(private deps: CheckerDeps) {
    this.path = join(deps.stateDir, UPDATES_FILE);
    this.self = deps.self ?? realSelfDeps;
    this.now = deps.now ?? Date.now;
    this.cache = readJsonGuarded<Cache>(this.path, { raw: [] }, (v) => !!v && typeof v === "object" && Array.isArray((v as Cache).raw));
  }

  /** The cached reading, with "installed" joined fresh. Never touches the network. */
  status(): UpdatesStatus {
    const c = this.cache;
    const off = checkForcedOff();
    const next = off ? null : this.nextManualCheckAt();
    return {
      self: { ...selfBase(this.self), ...(c.self ? { latest: c.self.latest, ...(c.self.notes ? { notes: c.self.notes } : {}) } : {}), ...(c.lastResult ? { lastResult: c.lastResult } : {}) },
      catalog: this.catalogRows(),
      ...(c.checkedAt ? { checkedAt: c.checkedAt } : {}),
      ...(off ? { error: OFF_SENTENCE } : c.error ? { error: c.error } : {}),
      autoCheck: !off && this.deps.autoCheck(),
      ...(c.lastApply ? { lastApply: c.lastApply } : {}),
      ...(next ? { nextCheckAt: next } : {}),
    };
  }

  /** When a manual check is next allowed, or null when it is allowed now. A failed attempt waits less than an ok one. */
  private nextManualCheckAt(): number | null {
    const at = this.cache.attemptedAt;
    if (!at) return null;
    const t = at + (this.cache.error ? CHECK_FLOOR_FAILED_MS : CHECK_FLOOR_MS);
    return t > this.now() ? t : null;
  }

  /**
   * The org catalogue joined with what is installed, plus one row for every manager install that is
   * NOT in it (installed by URL): `source: "manager"`, its `latest` from the cached remote check, or
   * null with a sentence saying why.
   */
  private catalogRows(): CatalogEntry[] {
    const installed = this.deps.installed();
    const rows = joinInstalled(this.cache.raw, installed);
    const seen = new Set(rows.flatMap((r) => (r.installed ? [r.installed.id] : [])));
    for (const i of installed) {
      if (i.source !== "manager" || seen.has(i.id) || !i.url) continue;
      const { url, ...inst } = i;
      const r = this.cache.remote?.[url];
      rows.push({
        repo: repoLabel(url), url, name: i.id, description: "", maturity: "unrated",
        latest: r?.latest ?? null, installed: inst, fromOrg: isOrgUrl(url),
        problems: r?.latest ? [] : [r?.problem ?? "Not checked yet."],
      });
    }
    return rows;
  }

  /** Daily timer: the first run a few minutes after boot (later if the cache is fresh), then every 24 h. */
  start(): void {
    if (this.timer) return;
    const since = this.now() - (this.cache.attemptedAt ?? 0);
    const wait = Math.max(this.deps.firstDelayMs ?? FIRST_CHECK_DELAY_MS, CHECK_EVERY_MS - since);
    const arm = (ms: number) => {
      this.timer = setTimeout(() => { void this.check({ timer: true }).finally(() => arm(CHECK_EVERY_MS)); }, ms);
      this.timer.unref?.();
    };
    arm(wait);
  }

  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }

  /** Broadcast `status()` again (an apply changed what is installed; no network, no floor). */
  refresh(): void { this.deps.onChange(this.status()); }

  /** Record the receipt of an apply/rollback (P3), kept across a restart. */
  setLastResult(r: { ok: boolean; message: string }): void {
    this.cache.lastResult = { ...r, at: this.now() };
    this.persist();
    this.deps.onChange(this.status());
  }

  /** Record the outcome of ANY apply (plugin install/update, self, restart); persisted and broadcast with the status. */
  setLastApply(r: Omit<UpdatesLastApply, "at">): void {
    this.cache.lastApply = { ...r, at: this.now() };
    this.persist();
    this.deps.onChange(this.status());
  }

  /**
   * Check now. Resolves true when a check RAN (its outcome was broadcast through `onChange`), false
   * when none did — switched off, inside the floor (10 min after an ok attempt, 30 s after a failed one; manual only), or one already running —
   * so the caller can answer the asker from `status()` itself.
   */
  async check(opts: { timer?: boolean } = {}): Promise<boolean> {
    if (checkForcedOff() || this.running) return false;
    if (opts.timer && !this.deps.autoCheck()) return false;
    const now = this.now();
    if (!opts.timer && this.nextManualCheckAt() !== null) return false;
    this.running = true;
    this.cache.attemptedAt = now;
    // The three parts fail independently: a failing part keeps its previous reading and says why in
    // its own sentence; `checkedAt` moves only when all of them were read.
    const fails: string[] = [];
    const why = (e: unknown) => (e instanceof GithubError ? e.message : e instanceof Error ? e.message : String(e)).replace(/\.+$/, "");
    let raw = this.cache.raw, sl = this.cache.self;
    try { raw = await (this.deps.fetchCatalog ?? ((prev) => fetchCatalog(undefined, prev)))(this.cache.raw); } catch (e) { fails.push(`Could not read the list of plugins: ${why(e)}.`); }
    try { sl = await selfLatest(this.self); } catch (e) { fails.push(`Could not check for a newer ${BRAND.slug}: ${why(e)}.`); }
    let remote = this.cache.remote;
    try { remote = await this.checkRemotes(raw); } catch (e) { fails.push(`Could not check the plugins installed by address: ${why(e)}.`); }
    this.cache = { ...this.cache, raw, self: sl, remote, ...(fails.length ? { error: fails.join(" ") } : { checkedAt: now, error: undefined }) };
    this.running = false;
    this.persist();
    this.deps.onChange(this.status());
    return true;
  }

  /** Each URL-installed plugin the org catalogue does not hold: one failure is that row's sentence, never the check's. */
  private async checkRemotes(raw: readonly RawCatalogEntry[]): Promise<NonNullable<Cache["remote"]>> {
    const out: NonNullable<Cache["remote"]> = {};
    const inOrg = new Set(joinInstalled(raw, this.deps.installed()).flatMap((r) => (r.installed ? [r.installed.id] : [])));
    for (const i of this.deps.installed()) {
      if (i.source !== "manager" || !i.url || inOrg.has(i.id) || out[i.url]) continue;
      try { out[i.url] = { latest: await (this.deps.remoteLatest ?? remoteLatest)(i.url) }; } catch (e) {
        out[i.url] = { latest: null, problem: `Could not check ${i.url} for a newer version: ${e instanceof Error ? e.message.replace(/\.+$/, "") : String(e)}.` };
      }
    }
    return out;
  }

  private persist(): void {
    try { writeJsonAtomic(this.path, this.cache); } catch { /* a cache that cannot be written is re-read next check */ }
  }
}
