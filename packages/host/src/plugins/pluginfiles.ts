/**
 * `api.offerFile` (plugin API 1.5): ONE file a plugin wrote into its own `dataDir`, handed to the
 * phone through the app's one download path — for a file that must not sit in a repo's outbox (an
 * encrypted backup file is the first user). Served by `GET /api/plugin-file/<id>/<token>`
 * (`routes/apisystem.ts`), behind the same origin/Host and token gates as every `/api` route: a
 * separate prefix, so no plugin route pattern can shadow it or be shadowed by it.
 *
 * Rules this file holds:
 *  - CONTAINED: the realpath of the file lies inside the realpath of the plugin's `dataDir`, the path
 *    itself is not a symlink, and it is a regular file — refused in words otherwise;
 *  - an unguessable token (24 random bytes) per offer, memory only — a restart forgets every offer;
 *  - the CORE deletes the file once ONE response delivered its last byte (a resumed download in
 *    ranges counts when the range that ends at the last byte finished), or at the TTL (default
 *    10 min, at most 1 h), or on `withdraw`, or when the plugin stops — and says which (`onGone`);
 *  - the name the phone saves it under is a plain file name, never a path.
 */
import { randomBytes } from "node:crypto";
import { lstatSync, realpathSync, rmSync, statSync } from "node:fs";
import { sep } from "node:path";
import { PLUGIN_FILE_TTL_MAX_MS, PLUGIN_FILE_TTL_MS, type PluginFileOffer, type PluginFileOfferOpts } from "@waterplane/shared";

type Why = "fetched" | "expired" | "withdrawn";

interface Offer {
  pluginId: string;
  token: string;
  file: string;
  name: string;
  size: number;
  mtime: number;
  expiresAt: number;
  timer: NodeJS.Timeout | null;
  onGone?: (why: Why) => void;
}

/** What the route needs of one live offer. */
export interface ServedFile { file: string; name: string; size: number; mtime: number; token: string; delivered(): void }

const NAME_RE = /^[A-Za-z0-9][\w. -]{0,119}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

export class PluginFiles {
  private readonly offers = new Map<string, Offer>();
  constructor(private readonly now: () => number = Date.now) {}

  private key = (pluginId: string, token: string): string => `${pluginId}/${token}`;

  /** Register `file` (inside `dataDir`) for download. THROWS a sentence. */
  offer(pluginId: string, pluginName: string, dataDir: string, file: string, opts: PluginFileOfferOpts): PluginFileOffer {
    const name = typeof opts?.name === "string" ? opts.name : "";
    if (!NAME_RE.test(name) || name.includes("..")) throw new Error(`${pluginName}: offerFile needs a plain file name (letters, digits, ".", "_", "-", space; at most 120), not ${JSON.stringify(name)}`);
    let real: string, root: string;
    try { root = realpathSync(dataDir); } catch { throw new Error(`${pluginName}: its data directory does not exist`); }
    try {
      if (lstatSync(file).isSymbolicLink()) throw new Error("symlink");
      real = realpathSync(file);
    } catch (e) {
      throw new Error((e as Error).message === "symlink"
        ? `${pluginName}: offerFile refuses a symlink (${file})`
        : `${pluginName}: offerFile: ${file} does not exist`);
    }
    if (!real.startsWith(root + sep)) throw new Error(`${pluginName}: offerFile serves only files inside its own data directory, not ${file}`);
    const st = statSync(real);
    if (!st.isFile()) throw new Error(`${pluginName}: offerFile serves a regular file, and ${file} is not one`);
    const asked = Number(opts.ttlMs);
    const ttl = Number.isFinite(asked) && asked > 0 ? Math.min(asked, PLUGIN_FILE_TTL_MAX_MS) : PLUGIN_FILE_TTL_MS;
    const token = randomBytes(24).toString("base64url");
    const o: Offer = { pluginId, token, file: real, name, size: st.size, mtime: Math.round(st.mtimeMs), expiresAt: this.now() + ttl, timer: null, ...(opts.onGone ? { onGone: opts.onGone } : {}) };
    o.timer = setTimeout(() => this.end(o, "expired"), ttl);
    o.timer.unref?.();
    this.offers.set(this.key(pluginId, token), o);
    return {
      path: `/api/plugin-file/${encodeURIComponent(pluginId)}/${token}`, size: o.size, expiresAt: o.expiresAt,
      withdraw: () => this.end(o, "withdrawn"),
    };
  }

  /** The live offer behind a route's `:id/:token`, or null (unknown, malformed or ended). */
  get(pluginId: string, token: string): ServedFile | null {
    if (!TOKEN_RE.test(token)) return null;
    const o = this.offers.get(this.key(pluginId, token));
    if (!o) return null;
    if (o.expiresAt <= this.now()) { this.end(o, "expired"); return null; }
    return { file: o.file, name: o.name, size: o.size, mtime: o.mtime, token: o.token, delivered: () => this.end(o, "fetched") };
  }

  /** Every offer of one plugin ends (it was switched off or stopped). */
  dropPlugin(pluginId: string): void {
    for (const o of [...this.offers.values()]) if (o.pluginId === pluginId) this.end(o, "withdrawn");
  }

  /** How many offers are live (tests, the status line). */
  count(pluginId?: string): number {
    return [...this.offers.values()].filter((o) => !pluginId || o.pluginId === pluginId).length;
  }

  private end(o: Offer, why: Why): void {
    if (this.offers.get(this.key(o.pluginId, o.token)) !== o) return;
    this.offers.delete(this.key(o.pluginId, o.token));
    if (o.timer) clearTimeout(o.timer);
    try { rmSync(o.file, { force: true }); } catch { /* already gone */ }
    try { o.onGone?.(why); } catch { /* the plugin's own callback: never the core's failure */ }
  }
}

/**
 * The last byte index a GET with this `Range` header asks for — the same reading `serveFileStream`
 * makes — or null when it is unsatisfiable. Whole file ⇒ size - 1.
 */
export function rangeLastByte(range: string | undefined, size: number): number | null {
  const m = /^bytes=(\d*)-(\d*)/.exec(range || "");
  if (!m || (!m[1] && !m[2])) return size - 1;
  let start: number, end = size - 1;
  if (m[1]) { start = parseInt(m[1], 10); if (m[2]) end = parseInt(m[2], 10); }
  else start = size - parseInt(m[2]!, 10);
  if (!Number.isFinite(start) || start < 0) start = 0;
  if (!Number.isFinite(end) || end >= size) end = size - 1;
  return start > end || start >= size ? null : end;
}
