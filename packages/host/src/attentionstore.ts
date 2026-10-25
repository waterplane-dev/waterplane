/**
 * The attention half of the notification feed, KEPT (notifications plan §2/§5).
 *
 * An `attention` item (`notifyLevel`) is something that waits on the person or
 * broke, so it must not evaporate with a host restart the way the in-memory
 * information feed does: it stays until the person taps done
 * (`handle`, `by: "person"`) or its cause goes away (`resolve`, `by:
 * "resolved"` with a note saying how — "fixed by the 14:02 push"). A handled
 * item is never deleted by either: it stays in the feed, stops counting, and
 * ages out of the handled cap like any other.
 *
 * One cause counts once: a new item whose `key` equals a still-unhandled one
 * hands the older one off as resolved ("replaced by a newer one"), so the bell
 * says 1 for a push that failed three times, not 3.
 *
 * Host-only extras (`detail`, the full failure text; `build`, the entry that
 * failed) live BESIDE the wire item and never ride a frame: the feed row
 * carries the one-line `body`; the repo listing (`gitFailed`/`buildFailed`)
 * hands out the full text where a person asked for that repo.
 *
 * Persisted to `<STATE_DIR>/attention.json` (`jsonstore`: tmp + fsync +
 * rename; a corrupt file is moved aside and the store starts empty). A null
 * path is a memory-only store — what a test or a `createClients` without one
 * gets.
 */
import { join } from "node:path";
import { buildAttentionKey, gitAttentionKey, needsYou, type NotificationItem } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

/** What only the host keeps about an attention item. */
export interface AttentionExtras {
  /** The full failure text (a push's whole hook output tail). Never on the wire item. */
  detail?: string;
  /** The build entry a failed build was (`buildAttentionKey`). */
  build?: { id: string; name: string };
}

export interface AttentionRecord { item: NotificationItem; extras?: AttentionExtras }

/** Newest N unhandled + newest N handled are kept; older ones age out. */
export const ATTENTION_CAP = 50;

const isRecord = (v: unknown): v is AttentionRecord => {
  const it = (v as AttentionRecord | null)?.item;
  return !!it && typeof it === "object" && typeof it.id === "string" && typeof it.ts === "number" && typeof it.kind === "string" && typeof it.title === "string";
};

export class AttentionStore {
  private recs: AttentionRecord[] = [];
  private readonly path: string | null;
  private listeners: (() => void)[] = [];

  /** `root` = the host root (state dir derived), or null for memory only. */
  constructor(root: string | null, file = "attention.json") {
    this.path = root === null ? null : join(hostStateDir(root), file);
    if (this.path) {
      const raw = readJsonGuarded<unknown>(this.path, null, (v) => !!v && typeof v === "object" && Array.isArray((v as { items?: unknown }).items));
      const items = (raw as { items?: unknown[] } | null)?.items ?? [];
      this.recs = items.filter(isRecord).map((r) => ({ item: { ...r.item, level: "attention" }, ...(r.extras ? { extras: r.extras } : {}) }));
      this.recs.sort((a, b) => b.item.ts - a.item.ts);
    }
  }

  /** Called after every change that persisted (add, resolve, handle, clear). */
  onChange(fn: () => void): void { this.listeners.push(fn); }

  /** The wire items, newest first (extras stripped). */
  items(): NotificationItem[] { return this.recs.map((r) => r.item); }

  /** Records still needing the person, newest first, optionally filtered. */
  unhandled(pred?: (r: AttentionRecord) => boolean): AttentionRecord[] {
    return this.recs.filter((r) => needsYou(r.item) && (!pred || pred(r)));
  }

  /** Keep a new attention item. A still-unhandled item under the same `key`
   *  is handed off as resolved first. Returns whether an older one was replaced. */
  add(item: NotificationItem, extras?: AttentionExtras): boolean {
    const now = item.ts;
    let replaced = false;
    if (item.key) {
      for (const r of this.recs) {
        if (r.item.key === item.key && !r.item.handled) {
          r.item = { ...r.item, handled: { at: now, by: "resolved", note: "replaced by a newer one" } };
          replaced = true;
        }
      }
    }
    const rec: AttentionRecord = { item: { ...item, level: "attention" } };
    if (extras && (extras.detail !== undefined || extras.build)) rec.extras = { ...extras };
    this.recs.unshift(rec);
    this.cap();
    this.changed();
    return replaced;
  }

  /** Every unhandled item whose key is `key` (or starts with it, `prefix`) ⇒
   *  handled `{by:"resolved", note}`. Returns how many changed; 0 writes nothing. */
  resolve(key: string, note: string, opts: { prefix?: boolean; at?: number } = {}): number {
    const at = opts.at ?? Date.now();
    let n = 0;
    for (const r of this.recs) {
      const k = r.item.key;
      if (!k || r.item.handled) continue;
      if (opts.prefix ? !k.startsWith(key) : k !== key) continue;
      r.item = { ...r.item, handled: { at, by: "resolved", note } };
      n++;
    }
    if (n) { this.cap(); this.changed(); }
    return n;
  }

  /** The person's done on one item. Idempotent: an unknown or already-handled
   *  id changes nothing and returns false. */
  handle(id: string, at = Date.now()): boolean {
    const r = this.recs.find((x) => x.item.id === id);
    if (!r || r.item.handled) return false;
    r.item = { ...r.item, handled: { at, by: "person" } };
    this.cap();
    this.changed();
    return true;
  }

  /** The feed's trash button: everything goes. */
  clear(): void {
    if (!this.recs.length) return;
    this.recs = [];
    this.changed();
  }

  private cap(): void {
    let open = 0, done = 0;
    this.recs = this.recs.filter((r) => (r.item.handled ? ++done : ++open) <= ATTENTION_CAP);
  }

  private changed(): void {
    if (this.path) {
      try { writeJsonAtomic(this.path, { v: 1, items: this.recs }); }
      catch (e) { console.error(`[attention] could not save ${this.path}: ${(e as Error).message}`); }
    }
    for (const fn of this.listeners) { try { fn(); } catch { /* a listener never breaks the store */ } }
  }
}

/** Newest unhandled record first matching — the listing's one predicate (`needsYou`). */
function newest(store: Pick<AttentionStore, "unhandled">, pred: (r: AttentionRecord) => boolean): AttentionRecord | undefined {
  return store.unhandled(pred)[0];
}

/** `RepoTarget.gitFailed` for one worktree id, off the store. */
export function gitFailedFor(store: Pick<AttentionStore, "unhandled">, repoId: string): { verb: "pull" | "push"; at: number; error: string; id: string } | undefined {
  const keys = new Map<string, "pull" | "push">([[gitAttentionKey(repoId, "push"), "push"], [gitAttentionKey(repoId, "pull"), "pull"]]);
  const r = newest(store, (x) => !!x.item.key && keys.has(x.item.key));
  if (!r) return undefined;
  return { verb: keys.get(r.item.key!)!, at: r.item.ts, error: r.extras?.detail ?? r.item.body, id: r.item.id };
}

/** `RepoTarget.buildFailed` for one worktree id, off the store. */
export function buildFailedFor(store: Pick<AttentionStore, "unhandled">, repoId: string): { buildId: string; name: string; at: number; error?: string; id: string } | undefined {
  const prefix = buildAttentionKey(repoId, "");
  const r = newest(store, (x) => !!x.item.key?.startsWith(prefix));
  if (!r) return undefined;
  const buildId = r.extras?.build?.id ?? r.item.key!.slice(prefix.length);
  const out: { buildId: string; name: string; at: number; error?: string; id: string } = { buildId, name: r.extras?.build?.name ?? buildId, at: r.item.ts, id: r.item.id };
  if (r.extras?.detail !== undefined) out.error = r.extras.detail;
  return out;
}
