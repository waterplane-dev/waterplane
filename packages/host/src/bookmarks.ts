/**
 * Conversation BOOKMARKS (R-conversations-007): "I will want to look at this
 * again", per repo directory, keyed by conversation id.
 *
 * Why it exists: a finished session used to be left OPEN only so its output
 * could be looked at later, because once closed it was one row among thousands
 * in the archive. A bookmark is the way back instead — the archive filters to
 * them, and a bookmarked conversation reads read-only straight off its log
 * without starting the CLI.
 *
 * One file, `<state dir>/bookmarks.json`, `{ [cwd]: { [convId]: Bookmark } }`,
 * written with `writeJsonAtomic` and read with `readJsonGuarded` (the host
 * persistence rule). Every entry goes through shared `cleanBookmark` on the way
 * in from disk and from the wire. The store does not check that a log exists —
 * the caller does (`apirepofiles.ts`) — and a bookmark whose log vanished is
 * simply never listed (`archive.ts` lists what is on disk); the archive's
 * delete drops the bookmark with the conversation.
 *
 * One instance per state directory (`bookmarkStore(root)`), so the route that
 * writes and the roster that stamps `SessionInfo.bookmark` read one map.
 */
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cleanBookmark, isConversationId, type Bookmark } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

type Listener = (cwd: string, convId: string) => void;

export class BookmarkStore {
  private byCwd = new Map<string, Map<string, Bookmark>>();
  private listeners = new Set<Listener>();

  constructor(private readonly path: string) {
    const raw = readJsonGuarded<Record<string, unknown>>(path, {}, (v) => !!v && typeof v === "object" && !Array.isArray(v));
    for (const [cwd, rows] of Object.entries(raw)) {
      if (!rows || typeof rows !== "object") continue;
      const m = new Map<string, Bookmark>();
      for (const [id, v] of Object.entries(rows as Record<string, unknown>)) {
        const b = cleanBookmark(v);
        if (b && isConversationId(id)) m.set(id, b);
      }
      if (m.size) this.byCwd.set(resolve(cwd), m);
    }
  }

  /** The bookmark on one conversation, if any. */
  get(cwd: string, convId: string | undefined): Bookmark | undefined {
    return convId ? this.byCwd.get(resolve(cwd))?.get(convId) : undefined;
  }

  /** Every bookmark in one directory, by conversation id (a copy). */
  of(cwd: string): Map<string, Bookmark> {
    return new Map(this.byCwd.get(resolve(cwd)) ?? []);
  }

  /**
   * Set (`raw`, cleaned) or remove (`null`) one bookmark. Returns the stored
   * bookmark, `null` for a removal, or `undefined` when refused (bad id, a
   * bookmark that does not clean). A removal of nothing is not an error.
   */
  set(cwd: string, convId: string, raw: unknown): Bookmark | null | undefined {
    if (!isConversationId(convId)) return undefined;
    const key = resolve(cwd);
    if (raw === null) {
      const m = this.byCwd.get(key);
      if (!m?.delete(convId)) return null;
      if (!m.size) this.byCwd.delete(key);
    } else {
      const b = cleanBookmark(raw);
      if (!b) return undefined;
      let m = this.byCwd.get(key);
      if (!m) { m = new Map(); this.byCwd.set(key, m); }
      m.set(convId, b);
    }
    this.persist();
    for (const fn of this.listeners) { try { fn(key, convId); } catch { /* a listener never fails a write */ } }
    return raw === null ? null : this.byCwd.get(key)!.get(convId)!;
  }

  /** Called after every change (the roster re-stamps live and closed rows). */
  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private persist(): void {
    const out: Record<string, Record<string, Bookmark>> = {};
    for (const [cwd, m] of this.byCwd) out[cwd] = Object.fromEntries(m);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeJsonAtomic(this.path, out, { space: 2 });
    } catch { /* non-fatal — writeJsonAtomic removed its own tmp file */ }
  }
}

const stores = new Map<string, BookmarkStore>();

/** The one store for this host's state directory. */
export function bookmarkStore(root: string): BookmarkStore {
  const path = join(hostStateDir(root), "bookmarks.json");
  let s = stores.get(path);
  if (!s) { s = new BookmarkStore(path); stores.set(path, s); }
  return s;
}
