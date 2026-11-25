/**
 * The paired-device ledger: which phones hold a token for this desktop.
 *
 * The host keeps one row per device (`.waterplane/devices.json`, token hashed at
 * rest); these are the rows as the phone sees them — never the hash. Revoking a
 * row kills its token at once. `lastSeenAt` is written at most once per
 * `DEVICE_SEEN_THROTTLE_MS` per device, so it is "seen within the last minute",
 * not a live presence.
 */

import type { PeerKind } from "./wire/messages.js";
import { cleanLabel } from "./hosts.js";

export const DEVICE_NAME_MAX = 40;
export const DEVICE_SEEN_THROTTLE_MS = 60_000;

export interface DeviceRow {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  /** The route the device last came in on; `null` when never recorded. */
  lastKind: PeerKind | null;
  /** The device making this request. */
  current?: boolean;
  /** `"passive"`: the kids'-phone scope — app updates only, everything else
   *  refused by the host until a PIN unlocks it (`passive.ts`). Absent = full. */
  scope?: DeviceScope;
  /** The name a password sign-in was made under when only the local network vouched for it (host
   *  `origin.ts` `unverifiedName`). Such a row ends on its own (`deviceEndsAt`) and its token counts
   *  under such a name only. Absent = an ordinary device. */
  under?: string;
}

/** How long a sign-in under such a name lasts. Whoever answers for the name is sent its cookie. */
export const NAME_SIGNIN_HOURS = 12;

/** When this row's token stops counting by itself, or null: until revoked. */
export function deviceEndsAt(row: Pick<DeviceRow, "createdAt" | "under">): number | null {
  return row.under === undefined ? null : row.createdAt + NAME_SIGNIN_HOURS * 60 * 60 * 1000;
}

/** A token's scope. Only `"passive"` is ever stored; absent means full. */
export type DeviceScope = "passive";

/** `GET /api/devices` → */
export interface DeviceListResponse {
  devices: DeviceRow[];
}

export interface DeviceRevokeResponse {
  ok: boolean;
  /** `false` when no such row existed (already revoked). */
  revoked: boolean;
  /** Live sockets of that device closed by the revoke. */
  closedSockets?: number;
}

export interface DeviceTokenResponse {
  token: string;
  deviceId: string;
}

export function isDeviceId(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(s);
}

/** A device name as typed or as the phone reports it; `null` when empty. */
export function normalizeDeviceName(raw: unknown): string | null {
  return cleanLabel(raw, DEVICE_NAME_MAX);
}

const PEER_KINDS: readonly PeerKind[] = ["loopback", "tailscale", "lan", "public", "unknown"];

function finiteTime(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** One row read off disk or the wire, or `null`. A row with no creation time
 *  cannot say when it was paired and is dropped rather than dated now. */
export function cleanDeviceRow(raw: unknown): DeviceRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isDeviceId(r.id)) return null;
  const name = normalizeDeviceName(r.name);
  const createdAt = finiteTime(r.createdAt);
  if (!name || createdAt == null) return null;
  const lastSeenAt = finiteTime(r.lastSeenAt) ?? createdAt;
  const lastKind = PEER_KINDS.includes(r.lastKind as PeerKind) ? (r.lastKind as PeerKind) : null;
  const row: DeviceRow = { id: r.id, name, createdAt, lastSeenAt, lastKind };
  if (r.current === true) row.current = true;
  if (r.scope === "passive") row.scope = "passive";
  // Present and unreadable is still a name sign-in: dropping the field would make its token last.
  if (r.under !== undefined) row.under = cleanLabel(r.under, DEVICE_NAME_MAX) ?? "?";
  return row;
}

/** This phone first, then most recently seen. */
export function sortDevices(rows: readonly DeviceRow[]): DeviceRow[] {
  return [...rows].sort((a, b) => Number(!!b.current) - Number(!!a.current) || b.lastSeenAt - a.lastSeenAt);
}

/** Should `lastSeenAt` be written now? */
export function deviceSeenDue(lastSeenAt: number, now: number): boolean {
  return now - lastSeenAt >= DEVICE_SEEN_THROTTLE_MS;
}
