/**
 * UI feature-usage counters — "which parts of this app do I actually use?".
 *
 * The phone tracks every feature invocation locally (instant, so the toolbar can
 * sort itself by frequency without a round-trip) and flushes deltas here; this
 * module merges them into one plain JSON file at <STATE_DIR>/ui-usage.json:
 *
 *   { "updatedAt": …, "since": …, "features": { "toolbar:diff": { count, first, last } } }
 *
 * The file is the point: a coding agent can read it and see which features are
 * hot, which are cold, and which have never fired at all — the input for
 * "delete what I never use". Nothing leaves the host; there is no network sink.
 *
 * Ids are opaque namespaced strings the client picks ("toolbar:<id>",
 * "overlay:<name>", "action:<name>"). Unknown ids are kept, not rejected, so
 * adding a `track()` call needs no host change — but they're sanity-capped so a
 * buggy/hostile client can't grow the file without bound.
 */
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";
import { join } from "node:path";
import type { UiUsageDoc } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";

const MAX_FEATURES = 1000;      // distinct ids retained (least-used dropped past this)
const MAX_ID_LEN = 80;
const MAX_DELTA = 10_000;       // per-id increment accepted in one flush
const SAVE_DEBOUNCE_MS = 3000;  // batch bursty flushes into one write

const ID_OK = /^[a-zA-Z0-9:._/-]+$/;

export class UiStats {
  private path: string;
  private doc: UiUsageDoc;
  private timer: NodeJS.Timeout | null = null;

  constructor(root: string) {
    this.path = join(hostStateDir(root), "ui-usage.json");
    this.doc = { updatedAt: 0, since: Date.now(), features: {} };
    const d = readJsonGuarded<UiUsageDoc | null>(this.path, null);
    if (d && typeof d === "object" && d.features) this.doc = { since: d.since || Date.now(), updatedAt: d.updatedAt || 0, features: d.features };
  }

  /** Merge a client delta ({ featureId: increment }). Returns the ids accepted. */
  merge(counts: Record<string, unknown>, at = Date.now()): number {
    if (!counts || typeof counts !== "object") return 0;
    let n = 0;
    for (const [rawId, rawN] of Object.entries(counts)) {
      const id = String(rawId).slice(0, MAX_ID_LEN);
      if (!ID_OK.test(id)) continue;
      const inc = Math.min(Math.max(Math.floor(Number(rawN) || 0), 0), MAX_DELTA);
      if (!inc) continue;
      const e = this.doc.features[id];
      if (e) { e.count += inc; e.last = at; }
      else this.doc.features[id] = { count: inc, first: at, last: at };
      n++;
    }
    if (!n) return 0;
    this.doc.updatedAt = at;
    this.prune();
    this.schedulePersist();
    return n;
  }

  /** The whole document (what the phone renders and an agent reads). */
  get(): UiUsageDoc {
    return { ...this.doc, features: { ...this.doc.features } };
  }

  /** Wipe all counters (start a fresh observation window). */
  reset(): void {
    this.doc = { updatedAt: Date.now(), since: Date.now(), features: {} };
    this.persist();
  }

  /** Write any debounced changes now (host shutdown). */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; this.persist(); }
  }

  private prune(): void {
    const ids = Object.keys(this.doc.features);
    if (ids.length <= MAX_FEATURES) return;
    // Drop the least-used, oldest-touched ids first.
    ids.sort((a, b) => this.doc.features[b].count - this.doc.features[a].count || this.doc.features[b].last - this.doc.features[a].last);
    for (const id of ids.slice(MAX_FEATURES)) delete this.doc.features[id];
  }

  private schedulePersist(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.persist(); }, SAVE_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  private persist(): void {
    try {
      writeJsonAtomic(this.path, this.doc, { space: 2 });
    } catch { /* telemetry must never break the host */ }
  }
}
