/**
 * The paired-device ledger: one row per phone/browser that holds a token for
 * this desktop, in `<STATE_DIR>/devices.json` (mode 0600).
 *
 * A token is 32 random bytes, base64url, handed out ONCE and kept on disk only
 * as its sha256 — a copy of the file lets nobody in. Lookup hashes the
 * presented token and compares it against EVERY row with `timingSafeEqual`, no
 * early exit, so the time taken says nothing about which row (if any) was close.
 *
 * Revoke = delete the row: its token is dead on the next request. A password
 * change DROPS EVERY ROW (not just the hashes): every gated device has to log
 * in again anyway, and a row with no token would be a device in the list that
 * can no longer do anything — a lie about who is paired.
 *
 * `lastSeenAt`/`lastKind` are written at most once per `DEVICE_SEEN_THROTTLE_MS`
 * per device, so a busy socket is not a disk write per request.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanDeviceRow, deviceSeenDue, normalizeDeviceName, sortDevices, type DeviceRow, type DeviceScope, type PeerKind } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

interface StoredRow extends DeviceRow { tokenHash: string }

/** Past this many rows the least recently seen is dropped on the next mint —
 *  a browser that logs in every week must not grow the file for ever. */
export const DEVICE_LEDGER_MAX = 200;

export function hashToken(tok: string): string {
  return createHash("sha256").update(tok, "utf8").digest("hex");
}

export class DeviceLedger {
  readonly file: string;
  private rows: StoredRow[] = [];

  constructor(root: string) {
    this.file = join(hostStateDir(root), "devices.json");
    this.load();
  }

  private load(): void {
    try {
      const j = readJsonGuarded<any>(this.file, null);
      const list: unknown[] = Array.isArray(j?.devices) ? j.devices : [];
      const seen = new Set<string>();
      for (const raw of list) {
        const row = cleanDeviceRow(raw);
        const h = (raw as { tokenHash?: unknown })?.tokenHash;
        if (!row || typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h) || seen.has(row.id)) continue;
        seen.add(row.id);
        delete row.current;
        this.rows.push({ ...row, tokenHash: h });
      }
    } catch { this.rows = []; }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeJsonAtomic(this.file, { devices: this.rows }, { mode: 0o600 });
    try { chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }

  /** Issue a token for a new device. The token is returned here and nowhere else.
   *  `scope` is stored on the row (only "passive" exists; absent = full). */
  mint(name: unknown, kind: PeerKind | null, now = Date.now(), scope?: DeviceScope): { token: string; row: DeviceRow } {
    const token = randomBytes(32).toString("base64url");
    let id: string;
    do { id = randomBytes(9).toString("base64url"); } while (this.rows.some((r) => r.id === id));
    const row: StoredRow = {
      id, name: normalizeDeviceName(name) ?? "device", createdAt: now, lastSeenAt: now, lastKind: kind, tokenHash: hashToken(token),
      ...(scope === "passive" ? { scope } : {}),
    };
    this.rows.push(row);
    if (this.rows.length > DEVICE_LEDGER_MAX) {
      this.rows.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
      this.rows.length = DEVICE_LEDGER_MAX;
    }
    this.persist();
    return { token, row: publicRow(row) };
  }

  /** The row a token belongs to, or null. Constant-time over the whole ledger. */
  lookup(tok: string | null | undefined): DeviceRow | null {
    if (!tok || tok.length > 256) return null;
    const want = Buffer.from(hashToken(tok), "hex");
    let hit: StoredRow | null = null;
    for (const r of this.rows) {
      if (timingSafeEqual(Buffer.from(r.tokenHash, "hex"), want) && !hit) hit = r;
    }
    return hit ? publicRow(hit) : null;
  }

  /** The public row for an id, or null. */
  get(id: string): DeviceRow | null {
    const r = this.rows.find((x) => x.id === id);
    return r ? publicRow(r) : null;
  }

  /** Note that a device was just seen; writes at most once per throttle window. */
  touch(id: string, kind: PeerKind, now = Date.now()): boolean {
    const r = this.rows.find((x) => x.id === id);
    if (!r || !deviceSeenDue(r.lastSeenAt, now)) return false;
    r.lastSeenAt = now;
    r.lastKind = kind;
    this.persist();
    return true;
  }

  /** The rows as the phone sees them (never a hash), `current` marked. */
  list(currentId?: string | null): DeviceRow[] {
    return sortDevices(this.rows.map((r) => {
      const row = publicRow(r);
      if (currentId && r.id === currentId) row.current = true;
      return row;
    }));
  }

  /** Delete a device's row; its token is dead at once. `false` ⇒ no such row. */
  revoke(id: string): boolean {
    const n = this.rows.length;
    this.rows = this.rows.filter((r) => r.id !== id);
    if (this.rows.length === n) return false;
    this.persist();
    return true;
  }

  /** Delete every row (password set/changed/cleared). */
  clear(): void {
    if (!this.rows.length) return;
    this.rows = [];
    this.persist();
  }

  get size(): number { return this.rows.length; }

  /** Some paired device is passive — `AuthManager` then holds Tailscale gated. */
  hasPassive(): boolean { return this.rows.some((r) => r.scope === "passive"); }
}

function publicRow(r: StoredRow): DeviceRow {
  return { id: r.id, name: r.name, createdAt: r.createdAt, lastSeenAt: r.lastSeenAt, lastKind: r.lastKind, ...(r.scope === "passive" ? { scope: r.scope } : {}) };
}
