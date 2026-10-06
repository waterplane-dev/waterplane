/**
 * The peer ledger: `peers.json` under the host's config dir (mode 0600) — one
 * row per OTHER waterplane host this desktop is paired with
 * (docs/analysis/peer-hosts-plan.md).
 *
 * A row can authenticate in two directions, kept apart on purpose:
 *  - **outbound** (we call them): the clear `token` is kept, because we must
 *    present it. It never leaves this module except through `outbound()`.
 *  - **inbound** (they call us): only `tokenSha256` is kept, like
 *    `deviceledger.ts` — a copy of the file lets nobody in. `authenticate()`
 *    hashes the presented token and compares it against EVERY row with
 *    `timingSafeEqual`, no early exit.
 *
 * Symmetric pairing (the phone's sheet always writes both) is one row with both
 * fields. A password change does NOT rotate peer tokens: separate ledger.
 *
 * Nothing here opens a socket. Reads degrade to "not paired", never to a guess.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { PEER_NAME_RE, cleanPeerRow, peerAddressOk, type PeerRow } from "@waterplane/shared";
import { readJsonGuarded, writeJsonAtomic } from "../jsonstore.js";

export const PEERS_FILE = "peers.json";
/** A token is 32 random bytes base64url (43 chars); accept a generous, bounded shape. */
export const PEER_TOKEN_RE = /^[A-Za-z0-9._~+/=-]{16,256}$/;
/** More peers than this is a mistake, not a fleet. */
export const PEERS_MAX = 32;

/** What the phone may see of a row: never a token, never a hash. */
export interface PeerPublic {
  name: string;
  addr: string;
  /** We can call them (a clear token is held). */
  outbound: boolean;
  /** They can call us (a token hash is held). */
  inbound: boolean;
  addedAt: number;
}

/** What `upsert` takes. An omitted token KEEPS the one already stored. */
export interface PeerUpsert {
  name: string;
  /** `host:port`, vouched for by `peerAddressOk`. */
  addr: string;
  /** The token WE present when we call them (kept in clear). */
  outboundToken?: string;
  /** The token THEY present when they call us (only its sha256 is kept). */
  inboundToken?: string;
}

export type PeerUpsertResult =
  | { ok: true; row: PeerPublic; replaced: boolean }
  | { ok: false; error: string };

/** The one interface WP3 (inbound serve) and WP4 (outbound jobs) code against. */
export interface PeerStore {
  /** Absolute path of `peers.json`. */
  readonly file: string;
  /** Every row, as the phone may see it (no secrets), oldest first. */
  list(): PeerPublic[];
  /** One row as the phone may see it, or null. */
  get(name: string): PeerPublic | null;
  /** Add or update a row (merging tokens); writes the file at 0600. A refusal is a sentence. */
  upsert(input: PeerUpsert, now?: number): PeerUpsertResult;
  /** Delete a row; both its tokens are dead at once. false = no such row. */
  remove(name: string): boolean;
  /**
   * INBOUND: the paired peer a presented bearer token belongs to, or null
   * (unlisted ⇒ the caller answers 403 "not paired"). Constant-time over the
   * whole ledger; a row with no inbound hash never matches.
   */
  authenticate(token: string | null | undefined): PeerPublic | null;
  /**
   * OUTBOUND: where and how to call a peer by name — address and the clear
   * token — or null when the peer is unlisted or we hold no token for it.
   */
  outbound(name: string): { name: string; addr: string; token: string } | null;
}

export function hashPeerToken(tok: string): string {
  return createHash("sha256").update(tok, "utf8").digest("hex");
}

const publicRow = (r: PeerRow): PeerPublic => ({
  name: r.name, addr: r.addr, outbound: !!r.token, inbound: !!r.tokenSha256, addedAt: r.addedAt,
});

class FilePeerStore implements PeerStore {
  readonly file: string;
  private rows: PeerRow[] = [];

  constructor(dir: string) {
    this.file = join(dir, PEERS_FILE);
    this.load();
  }

  private load(): void {
    try {
      const j = readJsonGuarded<any>(this.file, null);
      const list: unknown[] = Array.isArray(j?.peers) ? j.peers : [];
      const seen = new Set<string>();
      for (const raw of list) {
        const row = cleanPeerRow(raw);
        if (!row || seen.has(row.name)) continue;
        seen.add(row.name);
        this.rows.push(row);
      }
    } catch { this.rows = []; }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeJsonAtomic(this.file, { peers: this.rows }, { mode: 0o600 });
    try { chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }

  list(): PeerPublic[] { return this.rows.map(publicRow); }

  get(name: string): PeerPublic | null {
    const r = this.rows.find((x) => x.name === name);
    return r ? publicRow(r) : null;
  }

  upsert(input: PeerUpsert, now = Date.now()): PeerUpsertResult {
    const name = typeof input?.name === "string" ? input.name : "";
    if (!PEER_NAME_RE.test(name)) return { ok: false, error: "a peer's name is letters, digits, - and _ (max 32), starting with a letter or digit" };
    const bad = peerAddressOk(input.addr);
    if (bad) return { ok: false, error: bad };
    for (const [what, t] of [["outbound", input.outboundToken], ["inbound", input.inboundToken]] as const) {
      if (t !== undefined && (typeof t !== "string" || !PEER_TOKEN_RE.test(t))) return { ok: false, error: `the ${what} token must be 16-256 characters of A-Z a-z 0-9 . _ ~ + / = -` };
    }
    const prev = this.rows.find((r) => r.name === name);
    const token = input.outboundToken ?? prev?.token;
    const tokenSha256 = input.inboundToken !== undefined ? hashPeerToken(input.inboundToken) : prev?.tokenSha256;
    if (!token && !tokenSha256) return { ok: false, error: "a peer needs a token in at least one direction" };
    if (!prev && this.rows.length >= PEERS_MAX) return { ok: false, error: `at most ${PEERS_MAX} peers` };
    const row: PeerRow = { name, addr: input.addr.trim(), ...(token ? { token } : {}), ...(tokenSha256 ? { tokenSha256 } : {}), addedAt: prev?.addedAt ?? now };
    if (prev) this.rows[this.rows.indexOf(prev)] = row; else this.rows.push(row);
    this.persist();
    return { ok: true, row: publicRow(row), replaced: !!prev };
  }

  remove(name: string): boolean {
    const n = this.rows.length;
    this.rows = this.rows.filter((r) => r.name !== name);
    if (this.rows.length === n) return false;
    this.persist();
    return true;
  }

  authenticate(token: string | null | undefined): PeerPublic | null {
    if (!token || typeof token !== "string" || token.length > 256) return null;
    const want = Buffer.from(hashPeerToken(token), "hex");
    let hit: PeerRow | null = null;
    for (const r of this.rows) {
      if (!r.tokenSha256) continue;
      if (timingSafeEqual(Buffer.from(r.tokenSha256, "hex"), want) && !hit) hit = r;
    }
    return hit ? publicRow(hit) : null;
  }

  outbound(name: string): { name: string; addr: string; token: string } | null {
    const r = this.rows.find((x) => x.name === name);
    return r?.token ? { name: r.name, addr: r.addr, token: r.token } : null;
  }
}

/** Open (or start) the ledger under `dir` — the host's config dir (`hostSecretDir()`). */
export function createPeerStore(dir: string): PeerStore {
  return new FilePeerStore(dir);
}
