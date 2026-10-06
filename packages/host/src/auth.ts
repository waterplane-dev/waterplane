/**
 * LAN password gate. waterplane's boundary is normally the Tailscale network identity
 * (loopback + Tailscale peers are trusted). When the LAN interface is bound
 * (WATERPLANE_ALLOW_PUBLIC=1) that boundary is gone for same-WiFi devices, so those
 * connections get password-gated here. The password is managed ONLY from the
 * trusted path (loopback / Tailscale) — a LAN caller can never set or change it.
 *
 * Model:
 *   - loopback  → always trusted (this is the management path; never gated).
 *   - tailscale → trusted, UNLESS `gateTailscale` is on (defense-in-depth toggle).
 *   - lan/other → always needs a valid token; if no password is set, no token can
 *                 be valid, so LAN is denied outright ("deny until set").
 *
 * Tokens are per-DEVICE rows in the paired-device ledger (`deviceledger.ts`,
 * `.waterplane/devices.json`, sha256 at rest), so they survive a host restart and each
 * one can be revoked on its own. A browser gets one after a correct password, as
 * an httpOnly cookie; the Android shell (whose cross-site cookie is withheld)
 * mints one over the trusted path (`POST /api/auth/token`) and carries it as
 * `Authorization: Bearer` on fetch and as the `<wsProtocol>-tok.<tok>` WebSocket
 * subprotocol on the upgrade — `tokenFromRequest` reads all three.
 * Changing/clearing the password drops every row — every gated device is
 * logged out. No token is valid while no password is set (deny-until-set).
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readJsonGuardedDetail, writeJsonAtomic } from "./jsonstore.js";
import type { DeviceRow } from "@waterplane/shared";
import { peerKind, type PeerKind } from "./net.js";
import { DeviceLedger } from "./deviceledger.js";
import { BRAND, LEGACY } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";

export const AUTH_COOKIE = BRAND.cookie;
/** Cookies set by past identities: still READ, so a paired browser stays signed in across the rename. */
const LEGACY_AUTH_COOKIES: readonly string[] = LEGACY.map((l) => l.cookie);
/** The cookie's lifetime in the browser. The token itself lives until it is
 *  revoked or the password changes. */
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_LEN = 8;

interface Stored {
  salt: string;
  hash: string;
  /** Also require the password from Tailscale peers (loopback stays exempt). */
  gateTailscale?: boolean;
}

/** The feed row for an `auth.json` that was unreadable at boot (`AuthManager.lost`). */
export function authLostNotice(lost: NonNullable<AuthManager["lost"]>): { title: string; body: string; tag: string } {
  return {
    title: "Host password file was unreadable",
    body: "auth.json could not be read at start-up, so this host has no password: every LAN device is refused until one is set again. " +
      (lost.tailscaleGated
        ? "It may have required the password from Tailscale too, so Tailscale devices are refused as well; set the password again on the desktop itself (loopback). "
        : "Set the password again from Settings if you use LAN access. ") +
      (lost.movedTo ? `The damaged file is kept as ${lost.movedTo}.` : "The file could not be moved aside."),
    tag: "auth-lost",
  };
}

export class AuthManager {
  private file: string;
  private stored: Stored | null = null;
  /**
   * Set when `auth.json` was PRESENT and unreadable at boot: where its bytes went,
   * and whether Tailscale stays gated. Deny-until-set already keeps every LAN peer
   * out with no password; the one thing a lost file could OPEN is the
   * `gateTailscale` defense-in-depth toggle, so when the damaged bytes mention it
   * (or could not be read at all) Tailscale is refused too until a person sets or
   * clears the password from the desktop (loopback is never gated). Fail closed.
   */
  lost: { movedTo: string | null; error: string; tailscaleGated: boolean } | null = null;
  /** Every issued token, hashed, one row per device. Survives restarts. */
  readonly devices: DeviceLedger;

  constructor(root: string) {
    this.file = join(hostStateDir(root), "auth.json");
    this.devices = new DeviceLedger(root);
    // Guarded: a corrupt auth.json is moved aside and logged (never silently
    // overwritten by the next save). The fallback is "no password", which is
    // still deny-until-set for every LAN peer — the gate never opens on a loss.
    const isStored = (v: unknown): boolean =>
      !!v && typeof (v as Stored).salt === "string" && typeof (v as Stored).hash === "string";
    const read = readJsonGuardedDetail<Stored | null>(this.file, null, isStored);
    this.stored = read.value;
    if (read.corrupt) {
      let bytes: string | null = null;
      try { bytes = read.corrupt.movedTo ? readFileSync(read.corrupt.movedTo, "utf8") : null; } catch { bytes = null; }
      const tailscaleGated = bytes === null || /gateTailscale/.test(bytes);
      this.lost = { movedTo: read.corrupt.movedTo, error: read.corrupt.error, tailscaleGated };
    }
  }

  /** Tailscale is held gated by a lost file (see `lost`) until a person decides. */
  private lockedTailscale(): boolean { return !!this.lost?.tailscaleGated; }

  private persist(): void {
    if (!this.stored) {
      try { rmSync(this.file, { force: true }); } catch { /* nothing to remove */ }
      return;
    }
    // Atomic: an in-place write truncated by a kill left a file that parsed as
    // "no password" on the next boot. 0600 from the first byte.
    writeJsonAtomic(this.file, this.stored, { mode: 0o600 });
  }

  isEnabled(): boolean { return !!this.stored; }
  gateTailscale(): boolean { return !!this.stored?.gateTailscale || this.lockedTailscale(); }

  /** Set (or replace) the password. Rotates all tokens — every device re-logs. */
  setPassword(pw: string): void {
    if (!pw || pw.length < MIN_LEN) throw new Error(`password too short (min ${MIN_LEN})`);
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(pw, salt, 32).toString("hex");
    // A file lost while it may have gated Tailscale keeps that gate on: turning
    // it off is a separate, explicit tap.
    const gate = this.stored?.gateTailscale || this.lockedTailscale();
    this.stored = gate ? { salt, hash, gateTailscale: true } : { salt, hash };
    if (this.lost) this.lost = { ...this.lost, tailscaleGated: false };
    this.devices.clear();
    this.persist();
  }

  clearPassword(): void {
    this.stored = null;
    if (this.lost) this.lost = { ...this.lost, tailscaleGated: false };
    this.devices.clear();
    this.persist();
  }

  setGateTailscale(on: boolean): void {
    if (!this.stored) return; // meaningless without a password
    this.stored.gateTailscale = on;
    if (!on) delete this.stored.gateTailscale;
    this.persist();
  }

  verify(pw: string): boolean {
    if (!this.stored || !pw) return false;
    const got = scryptSync(pw, this.stored.salt, 32);
    const want = Buffer.from(this.stored.hash, "hex");
    return got.length === want.length && timingSafeEqual(got, want);
  }

  /** Mint a token for a new device row. Callers decide WHO may (a correct
   *  password, or an already-trusted caller); this only refuses while no
   *  password is set, because such a token could never pass the gate. */
  issueToken(deviceName: unknown, kind: PeerKind | null): { token: string; deviceId: string } {
    if (!this.isEnabled()) throw new Error("no password set on host");
    const { token, row } = this.devices.mint(deviceName, kind);
    return { token, deviceId: row.id };
  }

  /** The device a token belongs to, or null. Null for every token while no
   *  password is set. With `kind`, also notes the device as seen (throttled). */
  deviceFor(tok: string | undefined | null, kind?: PeerKind): DeviceRow | null {
    if (!tok || !this.isEnabled()) return null;
    const row = this.devices.lookup(tok);
    if (row && kind) this.devices.touch(row.id, kind);
    return row;
  }

  checkToken(tok: string | undefined | null, kind?: PeerKind): boolean {
    return this.deviceFor(tok, kind) !== null;
  }

  /** Log a token out: its device row is deleted. */
  revoke(tok: string | undefined | null): void {
    const row = tok ? this.devices.lookup(tok) : null;
    if (row) this.devices.revoke(row.id);
  }

  /** Whether a connection from `kind` must present a valid token to proceed. */
  needsToken(kind: PeerKind): boolean {
    if (kind === "loopback") return false;
    if (kind === "tailscale") return (this.isEnabled() && this.gateTailscale()) || this.lockedTailscale();
    return true; // lan / public / unknown — no password set ⇒ can't pass ⇒ denied
  }

  /** Whether a connection from `kind` may set/change/clear the password. Only the
   *  trusted path (loopback + Tailscale peers) manages auth — never LAN. */
  canManage(kind: PeerKind): boolean {
    return kind === "loopback" || kind === "tailscale";
  }
}

/** The WebSocket subprotocol prefix that carries a device token on the upgrade
 *  (a browser WebSocket can set no other header). */
export const WS_TOKEN_PROTOCOL_PREFIX = `${BRAND.wsProtocol}-tok.`;
/** Past identities' prefixes: an installed APK / cached bundle still offers one. */
const LEGACY_WS_TOKEN_PREFIXES: readonly string[] = LEGACY.map((l) => `${l.wsProtocol}-tok.`);
const WS_TOKEN_PREFIXES: readonly string[] = [WS_TOKEN_PROTOCOL_PREFIX, ...LEGACY_WS_TOKEN_PREFIXES];

/** Split a `Sec-WebSocket-Protocol` header into its offered protocols. */
function wsProtocols(h: string | string[] | undefined): string[] {
  const all = Array.isArray(h) ? h.join(",") : (h ?? "");
  return all.split(",").map((p) => p.trim()).filter(Boolean);
}

function bearer(h: string | undefined): string | null {
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]{1,256})\s*$/i.exec(h ?? "");
  return m ? m[1] : null;
}

/**
 * The token a request carries, first found wins: the `BRAND.cookie` cookie (the
 * browser PWA), then `Authorization: Bearer <tok>` (the Android shell's fetch),
 * then a `<wsProtocol>-tok.<tok>` WebSocket subprotocol (its socket). Null when none.
 * Only ever an opaque string — validity is `AuthManager.deviceFor`'s question.
 */
export function tokenFromRequest(headers: IncomingHttpHeaders): string | null {
  const c = cookieToken(headers.cookie);
  if (c) return c;
  const b = bearer(headers.authorization);
  if (b) return b;
  for (const p of wsProtocols(headers["sec-websocket-protocol"])) {
    for (const pre of WS_TOKEN_PREFIXES) {
      if (p.startsWith(pre) && p.length > pre.length) return p.slice(pre.length);
    }
  }
  return null;
}

/**
 * `WebSocketServer`'s `handleProtocols`: answer with the first offered protocol
 * that is NOT a token carrier (the phone offers `[<wsProtocol>, "<wsProtocol>-tok.<tok>"]`
 * and gets the base protocol back (an older client offers its own name; any non-token one is echoed)), so the token is never echoed in a response header.
 * Nothing but a token offered ⇒ `false`, no protocol selected — and a browser
 * then fails the handshake, which is why the client must offer a base protocol.
 */
export function selectWsProtocol(protocols: Set<string>): string | false {
  for (const p of protocols) if (!WS_TOKEN_PREFIXES.some((pre) => p.startsWith(pre))) return p;
  return false;
}

/** Pull the auth token out of a request's Cookie header. */
export function cookieToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === AUTH_COOKIE || LEGACY_AUTH_COOKIES.includes(name)) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Build the Set-Cookie header value for a freshly issued token. Not `Secure` —
 *  LAN access is plain HTTP; `HttpOnly` keeps it out of page JS, `SameSite=Lax`
 *  is enough for same-origin fetch + WS upgrade. */
export function authCookie(tok: string): string {
  return `${AUTH_COOKIE}=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(TOKEN_TTL_MS / 1000)}`;
}

export function clearAuthCookie(): string[] {
  // Expire the legacy-named cookies too, so a logout really logs the browser out.
  return [AUTH_COOKIE, ...LEGACY_AUTH_COOKIES].map((n) => `${n}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export { peerKind, type PeerKind };
