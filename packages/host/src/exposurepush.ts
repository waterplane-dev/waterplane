/**
 * **One push per new exposure finding** — the host half of `exposurepush.ts` in shared (which
 * decides; this module stores, sweeps and sends). Alert = a push the same day; the Monday digest is
 * not here.
 *
 *  - **Store**: `<exposure dir>/pushed.json`, `{v:2, keys, repos}` (v1 = keys, no repos), written with
 *    `writeJsonAtomic`, never pruned (a finding is pushed once forever). Keys are REMEMBERED BEFORE
 *    sending: a crash between the two loses a push, never repeats one.
 *  - **Seeding is per repo**: a repo not yet in `repos` (first sight as watched, whatever the reason,
 *    including no store at all) remembers its open alerts, pushes none, and is added.
 *  - **Resolving**: every push carries `key: exposure:<repo>:<finding key>` (summary:
 *    `exposure:<repo>`); a sweep resolves the keys whose finding is no longer open.
 *  - **An accepts file that exists but cannot be read** skips that repo for the sweep.
 *  - **A store that cannot be read** is logged and NOTHING is pushed or written: re-pushing
 *    everything is the failure this guards. (A corrupt file `readJsonGuarded` moved aside counts as
 *    "no store": every watched repo seeds quietly.)
 *  - **Cheap**: `exposureSeriesAll` reads through `newestRow`'s mtime+size cache, so a quiet 10
 *    minutes is one stat per series. Boot sweep after a short delay, then every 10 minutes.
 *  - Words only; nothing is fixed, accepted or muted by a push.
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { exposurePushes, logTag, type ExposureSeries, type NotifyOpen } from "@waterplane/shared";
import { exposureDir, exposureSeriesAll } from "./exposure.js";
import { exposureWatchedDirs } from "./exposurewatch.js";
import { readJsonGuardedDetail, writeJsonAtomic } from "./jsonstore.js";
import type { Notify } from "./notifytypes.js";
import { discoverTargets } from "./repos.js";

const BOOT_DELAY_MS = 30_000;
const SWEEP_MS = 10 * 60_000;
const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

export interface ExposurePushDeps {
  notify: Notify;
  /** Tests: where the store lives (default `<exposure dir>/pushed.json`). */
  storePath?: () => string;
  series?: () => ExposureSeries[];
  /** The real dirs on the watch, or null when targets.json is unusable. */
  watched?: () => Set<string> | null;
  /** A watched dir -> the repo id the phone opens (undefined = not a discovered repo). */
  repoIdFor?: (dir: string) => Promise<string | undefined>;
  now?: () => Date;
  /** Resolve an attention item by its key (`ctx.resolveAttention`); absent = keys are only set. */
  resolveAttention?: (key: string, note: string) => number;
}

type Store = { ok: true; keys: Set<string>; repos: Set<string> } | { ok: false; why: string };
const EMPTY = (): Store => ({ ok: true, keys: new Set(), repos: new Set() });

export class ExposurePush {
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;
  private readonly warned = new Set<string>();
  constructor(private readonly deps: ExposurePushDeps) {}

  private path(): string { return this.deps.storePath?.() ?? join(exposureDir(), "pushed.json"); }

  private load(): Store {
    const p = this.path();
    if (!existsSync(p)) return EMPTY();
    const r = readJsonGuardedDetail<{ v: 1 | 2; keys: string[]; repos?: string[] } | null>(p, null,
      (v) => !!v && typeof v === "object" && ((v as { v?: unknown }).v === 1 || (v as { v?: unknown }).v === 2) && Array.isArray((v as { keys?: unknown }).keys));
    if (r.corrupt) {
      return r.corrupt.movedTo ? EMPTY() : { ok: false, why: r.corrupt.error };
    }
    if (!r.value) return { ok: false, why: "empty" };
    const strs = (a: unknown): string[] => (Array.isArray(a) ? a.filter((k): k is string => typeof k === "string") : []);
    return { ok: true, keys: new Set(strs(r.value.keys)), repos: new Set(r.value.v === 2 ? strs(r.value.repos) : []) };
  }

  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const watchedDirs = (this.deps.watched ?? exposureWatchedDirs)();
      if (!watchedDirs) return; // targets.json present but unusable: nobody is known to be watched
      const store = this.load();
      if (!store.ok) { console.log(`${logTag} exposure push · pushed.json unreadable (${store.why}); pushing nothing until it is`); return; }
      const series = (this.deps.series ?? exposureSeriesAll)();
      for (const s of series) {
        if (s.unreadable && watchedDirs.has(real(s.row.dir)) && !this.warned.has(s.row.repo)) {
          this.warned.add(s.row.repo);
          console.log(`${logTag} exposure push · ${s.row.repo}: accepts or triage file unreadable; skipping this repo until it is`);
        }
      }
      const plan = exposurePushes(series, (d) => watchedDirs.has(real(d)), store, (this.deps.now ?? (() => new Date()))());
      for (const k of plan.resolve) this.deps.resolveAttention?.(k, "no longer an open finding");
      if (plan.remember.length || plan.seenRepos.length) {
        // Remember BEFORE sending: a crash between the two loses a push, never repeats one.
        const keys = new Set([...store.keys, ...plan.remember]);
        const repos = new Set([...store.repos, ...plan.seenRepos]);
        try {
          mkdirSync(exposureDir(), { recursive: true });
          writeJsonAtomic(this.path(), { v: 2, keys: [...keys], repos: [...repos] }, { space: 2, newline: true });
        } catch (e) { console.log(`${logTag} exposure push · could not save pushed.json (${e instanceof Error ? e.message : String(e)}); pushing nothing`); return; }
      }
      if (!plan.push.length) return;
      const targets = await (this.deps.repoIdFor ? null : discoverTargets(rootForDiscovery).catch(() => []));
      for (const p of plan.push) {
        const repoId = this.deps.repoIdFor
          ? await this.deps.repoIdFor(p.dir).catch(() => undefined)
          : targets?.find((t) => real(t.worktreePath) === real(p.dir))?.id;
        const open: NotifyOpen | undefined = repoId ? { to: "setup", repoId } : undefined;
        try {
          this.deps.notify("exposure", { title: p.title, body: p.body, tag: p.tag, key: p.key, level: p.attention ? "attention" : "info", ...(open ? { open } : {}) });
        } catch (e) { console.log(`${logTag} exposure push · notify failed (${e instanceof Error ? e.message : String(e)}); key stays remembered`); }
      }
    } catch (e) {
      console.log(`${logTag} exposure push · ${e instanceof Error ? e.message : String(e)}`);
    } finally { this.sweeping = false; }
  }

  start(): void {
    if (this.timer) return;
    const first = setTimeout(() => { void this.sweep(); this.timer = setInterval(() => void this.sweep(), SWEEP_MS); this.timer.unref?.(); }, BOOT_DELAY_MS);
    first.unref?.();
    this.timer = first;
  }

  stop(): void { if (this.timer) { clearTimeout(this.timer); clearInterval(this.timer); this.timer = null; } }
}

let rootForDiscovery = "";

export function createExposurePush(root: string, notify: Notify, resolveAttention?: (key: string, note: string) => number): ExposurePush {
  rootForDiscovery = root;
  return new ExposurePush({ notify, resolveAttention });
}
