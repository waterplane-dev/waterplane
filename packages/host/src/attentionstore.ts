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
 * One cause counts once: a new item whose IDENTITY equals a still-unhandled
 * one's hands the older one off as resolved ("replaced by a newer one"), so the
 * bell says 1 for a push that failed three times, not 3. The identity is the
 * `key`, except for a failed push filed with its branch: that one is per BRANCH
 * (`attentionIdentity`, `gitPushFailureKey`) — a failure on another branch is
 * another cause, never a replacement (review A3b). `resolve` matches the same
 * identity, so the bare push key no longer reaches a branch's record.
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
import { buildAttentionKey, gitAttentionKey, gitPushFailureKey, needsYou, parseAttentionKey, type NotificationItem, type RepoTarget } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

/** What only the host keeps about an attention item. */
export interface AttentionExtras {
  /** The full failure text (a push's whole hook output tail). Never on the wire item. */
  detail?: string;
  /** The build entry a failed build was (`buildAttentionKey`). */
  build?: { id: string; name: string };
  /** A failed push: the branch and commit that did not go up. It is resolved only once that
   *  commit is on that branch's upstream (`gitnotify.ts`). Absent on a record an older host
   *  kept — such a record is cleared, as it always was, by the next push that succeeds. */
  pushHead?: { branch: string; sha: string };
}

export interface AttentionRecord { item: NotificationItem; extras?: AttentionExtras }

/** Newest N unhandled + newest N handled are kept; older ones age out. */
export const ATTENTION_CAP = 50;

/** A kept `pushHead` read back, or undefined when it is not the shape the host writes
 *  (a hand-edited or older file): such a record is an unknown branch. */
function validHead(h: unknown): { branch: string; sha: string } | undefined {
  const x = h as { branch?: unknown; sha?: unknown } | null | undefined;
  return x && typeof x.branch === "string" && x.branch && !x.branch.includes(":") && typeof x.sha === "string" && /^[0-9a-f]{40,64}$/.test(x.sha)
    ? { branch: x.branch, sha: x.sha } : undefined;
}

/** What one cause IS for "replaced by a newer one" and `resolve`: the item's key, or for a
 *  failed push filed with its branch, that key plus the branch (`gitPushFailureKey`'s form). */
export function attentionIdentity(r: AttentionRecord): string | undefined {
  const k = r.item.key;
  if (!k) return undefined;
  const h = validHead(r.extras?.pushHead);
  if (!h) return k;
  const p = parseAttentionKey(k);
  return p?.kind === "git" && p.verb === "push" ? gitPushFailureKey(p.repoId, h.branch) : k;
}

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
      this.recs = items.filter(isRecord).map((r) => {
        // A record filed before the wire item carried its branch gets it from its kept head.
        const head = validHead(r.extras?.pushHead);
        return { item: { ...r.item, level: "attention", ...(head ? { branch: head.branch } : {}) }, ...(r.extras ? { extras: r.extras } : {}) };
      });
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
   *  is handed off as resolved first. Returns the item AS KEPT (enriched: a failed push's
   *  `branch`) — the one object the live frame, the OS push and the feed all carry, never a
   *  second hand-built copy — and whether an older one was replaced. */
  add(item: NotificationItem, extras?: AttentionExtras): { item: NotificationItem; replaced: boolean } {
    const now = item.ts;
    let replaced = false;
    const rec: AttentionRecord = { item: { ...item, level: "attention" } };
    if (extras && (extras.detail !== undefined || extras.build || extras.pushHead)) {
      rec.extras = { ...extras };
      for (const k of ["detail", "build", "pushHead"] as const) if (rec.extras[k] === undefined) delete rec.extras[k];
    }
    // The branch the key cannot carry (its format is frozen for phones in the field): its own
    // optional wire field, set only from a head the store itself files under.
    const head = validHead(rec.extras?.pushHead);
    if (head) rec.item.branch = head.branch;
    else delete rec.item.branch;
    const id = attentionIdentity(rec);
    if (id) {
      for (const r of this.recs) {
        if (!r.item.handled && attentionIdentity(r) === id) {
          r.item = { ...r.item, handled: { at: now, by: "resolved", note: "replaced by a newer one" } };
          replaced = true;
        }
      }
    }
    this.recs.unshift(rec);
    this.cap();
    this.changed();
    return { item: rec.item, replaced };
  }

  /** Every unhandled item whose identity (`attentionIdentity`: the key, or a failed push's
   *  key + branch) is `key` (or starts with it, `prefix`) ⇒ handled `{by:"resolved", note}`.
   *  Returns how many changed; 0 writes nothing. */
  resolve(key: string, note: string, opts: { prefix?: boolean; at?: number } = {}): number {
    const at = opts.at ?? Date.now();
    let n = 0;
    for (const r of this.recs) {
      const k = attentionIdentity(r);
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

type GitFailed = NonNullable<RepoTarget["gitFailed"]>;

/** `RepoTarget.gitFailures` for one worktree id, off the store: every unhandled failed pull or
 *  push there, newest first — one per branch for a push — so the git view shows the record that
 *  was TAPPED, not whichever is newest (review A3b). */
export function gitFailuresFor(store: Pick<AttentionStore, "unhandled">, repoId: string): GitFailed[] {
  const out: GitFailed[] = [];
  for (const r of store.unhandled()) {
    const k = parseAttentionKey(r.item.key);
    if (k?.kind !== "git" || k.repoId !== repoId) continue;
    const head = validHead(r.extras?.pushHead);
    out.push({ verb: k.verb, at: r.item.ts, error: r.extras?.detail ?? r.item.body, id: r.item.id, ...(head ? { branch: head.branch } : {}) });
  }
  return out;
}

/** `RepoTarget.gitFailed` for one worktree id, off the store: the newest of `gitFailuresFor`. */
export function gitFailedFor(store: Pick<AttentionStore, "unhandled">, repoId: string): GitFailed | undefined {
  return gitFailuresFor(store, repoId)[0];
}

/** The branch and commit of a repo's NEWEST still-unhandled failed push, when it was filed with
 *  them (a record an older host kept has none: undefined) — for display; each branch's failure is
 *  its own record (`pushFailures`). A malformed shape on disk is none too. */
export function pushFailureHead(store: Pick<AttentionStore, "unhandled">, repoId: string): { branch: string; sha: string } | undefined {
  return pushFailures(store, repoId)[0]?.head;
}

/** Every still-unhandled failed push of one repo, newest first: its identity (what `resolve`
 *  takes) and, when it was filed with one, the branch and commit that did not go up. */
export function pushFailures(store: Pick<AttentionStore, "unhandled">, repoId: string): { identity: string; head?: { branch: string; sha: string } }[] {
  const key = gitAttentionKey(repoId, "push");
  return store.unhandled((x) => x.item.key === key).map((r) => {
    const head = validHead(r.extras?.pushHead);
    return head ? { identity: gitPushFailureKey(repoId, head.branch), head } : { identity: key };
  });
}

/** `RepoTarget.buildFailed` for one worktree id, off the store. */
export function buildFailedFor(store: Pick<AttentionStore, "unhandled">, repoId: string): { buildId: string; name: string; at: number; error?: string; id: string } | undefined {
  // The entry kept beside the record names the key exactly (a build id may hold `:`, which the
  // key's last segment cannot); a record without it is read back by the one parser.
  const mine = (x: AttentionRecord) => x.extras?.build ? x.item.key === buildAttentionKey(repoId, x.extras.build.id) : (() => { const k = parseAttentionKey(x.item.key); return k?.kind === "build" && k.repoId === repoId; })();
  const r = newest(store, mine);
  if (!r) return undefined;
  const k = parseAttentionKey(r.item.key);
  const buildId = r.extras?.build?.id ?? (k?.kind === "build" ? k.buildId : "");
  const out: { buildId: string; name: string; at: number; error?: string; id: string } = { buildId, name: r.extras?.build?.name ?? buildId, at: r.item.ts, id: r.item.id };
  if (r.extras?.detail !== undefined) out.error = r.extras.detail;
  return out;
}
