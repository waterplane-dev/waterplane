/**
 * This phone's device token on the active host, and the two rules about
 * carrying it.
 *
 * The token is one row of the host's device ledger (`host/deviceledger.ts`),
 * minted by `POST /api/auth/token` over the tailnet (`lanLink.ts`). It exists
 * so the APK can pass the LAN password gate: the cookie a browser would use is
 * `SameSite=Lax` and withheld from `http://localhost` → the host, so the shell
 * carries the token itself — `Authorization: Bearer` on fetch/XHR (the
 * transports `hostUrl.ts` patches) and a `<proto>-tok.<tok>` WebSocket
 * subprotocol on the upgrade (`ws.ts`).
 *
 * **Only ever to the host base.** `bearerFor` is the one gate: a request to
 * any other origin — a third party, or the LAN address while it is still
 * being PROBED and VERIFIED — gets no header. The LAN address only becomes the
 * host base after its MAC checked out (`lanRoute.ts`), so "never send the
 * token before the MAC" holds by construction rather than by a call site
 * remembering it.
 *
 * Host-scoped (`KEY_SCOPE`): a host switch parks it with that host's words.
 * The pure half (`bearerFor`, `wsProtocols`, `pickDeviceName`) is node-tested.
 *
 * **Sealed mode** (`tokenVault.ts`): the tokens leave storage for one Keystore blob and live in
 * `held` below, by host id, for this run only. Every reader goes through `deviceToken()` or
 * `tokenForHost()`, so `hostUrl.ts`, `ws.ts` and `lanLink.ts` never learn the mode exists. Storage
 * is still read when nothing is held: what stays plain in this mode is a passive token, which the
 * passive screen needs and no prompt ever guards. With the mode off `held` is never consulted.
 *
 * **The LAN identity rides with the token.** `{hostId, secret}` is what a Wi-Fi answer is checked
 * against before the token goes to it (`lanRoute.ts`), so a copy of it is half of taking the token
 * on a row with no TLS pin. In sealed mode it lives in the same blob and in `heldLan` below, keyed
 * like the tokens by the ROW id; `lanIdentity()` is the one reader, `setLanIdentity` and
 * `dropLanIdentity` the writers, so `lanLink.ts` never learns the mode either. An identity that
 * arrives while sealed (read over the tailnet) is held for this run and joins the blob at the next
 * re-wrap: no sheet is raised for a value nobody asked for, and the tailnet hands it out again.
 */
import { BRAND, parkedKeyFor } from "@waterplane/shared";
import { LS, lsDel, lsGet, lsJson, lsSet, lsSetJson } from "./storage.ts";

export interface LanIdentity { hostId: string; secret: string }

/** A stored/served identity, or null for anything that is not one. */
export function parseLanIdentity(v: unknown): LanIdentity | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return typeof o.hostId === "string" && o.hostId && typeof o.secret === "string" && o.secret.length >= 16
    ? { hostId: o.hostId, secret: o.secret }
    : null;
}

/** The base subprotocol the host echoes; the token rides as a SECOND offer
 *  (a token-only offer fails the handshake — the host answers only the base protocol). */
export const WS_BASE_PROTOCOL = BRAND.wsProtocol;
export const WS_TOKEN_PREFIX = `${BRAND.wsProtocol}-tok.`;

/** A token as the host mints them: base64url-ish, no separators. Anything else
 *  in the key is a hand edit and is not sent. */
function validToken(t: string | null): t is string {
  return !!t && /^[A-Za-z0-9_-]{16,256}$/.test(t);
}

/** Is `t` shaped like a token the host mints? (`pairRedeem.ts` stores one.) */
export function isDeviceToken(t: unknown): t is string {
  return typeof t === "string" && validToken(t);
}

// ── Sealed mode: the tokens of this run ─────────────────────────────────

const held = new Map<string, string>();
/** The LAN identities of this run, by row id. Same life as `held`. */
const heldLan = new Map<string, LanIdentity>();
/** Did the map get the blob's contents? Until then it may hold only what arrived this run. */
let heldComplete = false;

export function sealedMode(): boolean {
  return lsGet(LS.tokenSealOn) === "1";
}

/** The token held in memory for desktop `id`, whatever the mode. */
export function heldToken(id: string): string | null {
  return held.get(id) ?? null;
}

/** Fill the map from an unsealed blob. Something that arrived during this run is newer than the
 *  blob, so it stays. Fires the token event: the background link re-reads what it may carry. */
export function holdTokens(tokens: Readonly<Record<string, string>>, lan: Readonly<Record<string, unknown>> = {}): void {
  for (const [id, t] of Object.entries(tokens)) if (validToken(t) && !held.has(id)) held.set(id, t);
  for (const [id, v] of Object.entries(lan)) {
    const got = parseLanIdentity(v);
    if (got && !heldLan.has(id)) heldLan.set(id, got);
  }
  heldComplete = true;
  tokenChanged();
}

/** One token that arrived in sealed mode (a pairing); `rewrap` is the caller's. */
export function holdToken(id: string, tok: string): void {
  if (validToken(tok)) held.set(id, tok);
}

export function forgetHeldToken(id: string): void {
  held.delete(id);
}

/** One identity that arrived in sealed mode (a sealed pairing); `rewrap` is the caller's. */
export function holdLanIdentity(id: string, v: unknown): void {
  const got = parseLanIdentity(v);
  if (got) heldLan.set(id, got);
}

export function forgetHeldLanIdentity(id: string): void {
  heldLan.delete(id);
}

/** Every identity held this run, by row id. Not a complete list unless `heldTokens()` is one. */
export function heldLanIdentities(): Record<string, LanIdentity> {
  return Object.fromEntries(heldLan);
}

/** Empty the map (the mode went off, its tokens are back in storage). */
export function releaseTokens(): void {
  held.clear();
  heldLan.clear();
  heldComplete = false;
}

/**
 * Everything to seal, or null while the blob has not been opened this run: after "open without
 * the sign-ins" the map holds only what arrived since, and wrapping that would replace every other
 * desktop's sign-in with nothing. Null means unwrap first, or leave the blob as it is.
 */
export function heldTokens(): Record<string, string> | null {
  return heldComplete ? Object.fromEntries(held) : null;
}

export function deviceToken(): string | null {
  const id = sealedMode() ? lsGet(LS.hostActive) : null;
  const h = id ? held.get(id) : undefined;
  if (h) return h;
  const t = lsGet(LS.deviceToken);
  return validToken(t) ? t : null;
}

/** This phone's token for saved desktop `id`, active or parked: the one read for a desktop by id. */
export function tokenForHost(id: string): string | null {
  const h = sealedMode() ? held.get(id) : undefined;
  if (h) return h;
  const t = lsGet(id === lsGet(LS.hostActive) ? LS.deviceToken : parkedKeyFor(LS.deviceToken, id));
  return validToken(t) ? t : null;
}

/**
 * The active desktop's LAN identity: the one read. Sealed, the held copy; storage is still read
 * when nothing is held, which is a blob sealed before identities went into it (its plain copy
 * stays until the next re-wrap takes it in).
 */
export function lanIdentity(): LanIdentity | null {
  const id = sealedMode() ? lsGet(LS.hostActive) : null;
  const h = id ? heldLan.get(id) : undefined;
  return h ?? parseLanIdentity(lsJson<unknown>(LS.lanIdentity, null));
}

/** Keep the active desktop's identity. Sealed: memory only, never a plain key (the header says why
 *  no sheet); with no active desktop there is no row to hold it under, so it is not kept. */
export function setLanIdentity(v: LanIdentity): void {
  if (!sealedMode()) { lsSetJson(LS.lanIdentity, v); return; }
  const id = lsGet(LS.hostActive);
  if (id) heldLan.set(id, v);
}

/** Never touches the blob: a stale entry there fails its check and is dropped again. */
export function dropLanIdentity(): void {
  if (sealedMode()) { const id = lsGet(LS.hostActive); if (id) heldLan.delete(id); }
  lsDel(LS.lanIdentity);
}

/** Fired after this phone's token on the active host was set or dropped, so the background link
 *  (`shellLink.ts`) re-hands its links: a token it was refused is resent only once a NEW one exists. */
export const DEVICE_TOKEN_EVENT = "app:device-token";

function tokenChanged(): void {
  try { if (typeof window !== "undefined") window.dispatchEvent(new Event(DEVICE_TOKEN_EVENT)); } catch { /* torn down */ }
}

export function setDeviceToken(tok: string): void {
  if (!validToken(tok)) return;
  // Sealed: memory only. Prompting for a token nobody asked for is wrong, and the mints that land
  // here are free to repeat over the tailnet at the next start.
  if (sealedMode()) { const id = lsGet(LS.hostActive); if (id) held.set(id, tok); }
  else lsSet(LS.deviceToken, tok);
  tokenChanged();
}

/** Never touches the blob: a stale entry there is refused by the host and dropped again. */
export function dropDeviceToken(): void {
  if (sealedMode()) { const id = lsGet(LS.hostActive); if (id) held.delete(id); }
  lsDel(LS.deviceToken);
  tokenChanged();
}

/** The `Authorization` value for a request to `url`, or null. Only when `url`
 *  is on the same ORIGIN as `base` (the host base in force right now), and never on `pake/*`: those
 *  run over a plain port, and the token a re-pair retires rides sealed in the `box` instead. */
export function bearerFor(url: string, base: string | null, tok: string | null): string | null {
  if (!tok || !base) return null;
  try {
    const u = new URL(url);
    if (u.pathname.startsWith("/api/pair/pake/")) return null;
    return u.origin === new URL(base).origin ? `Bearer ${tok}` : null;
  } catch {
    return null;
  }
}

/**
 * The `Authorization` value for a request to ANOTHER saved desktop (`url`), carrying that
 * desktop's own PARKED token — or null. The same rule as `bearerFor` with the saved TAILNET
 * `base` as the only origin: never its LAN address (dialled only after a MAC check, which runs
 * for the active host alone, `lanRoute.ts`), never any other origin, never a hand-edited token.
 */
export function bearerForSaved(host: { base: string; lan?: { base: string } }, tok: string | null, url: string): string | null {
  if (!validToken(tok)) return null;
  try {
    const origin = new URL(url).origin;
    if (host.lan?.base && new URL(host.lan.base).origin === origin) return null;
    if (!/^https?:$/.test(new URL(url).protocol)) return null;
  } catch {
    return null;
  }
  return bearerFor(url, host.base, tok);
}

/** The subprotocols to offer on the upgrade: none without a token (the socket
 *  dials exactly as it always did), `[base, "<base>-tok.<tok>"]` with one. */
export function wsProtocols(tok: string | null): string[] | undefined {
  return tok ? [WS_BASE_PROTOCOL, `${WS_TOKEN_PREFIX}${tok}`] : undefined;
}

/** What to call this phone in the host's ledger: the name somebody gave it,
 *  then its model, then a plain word — never blank (the host refuses blank). */
export function pickDeviceName(name: string, model: string): string {
  return (name.trim() || model.trim() || "Android phone").slice(0, 60);
}

// ── A refused token ─────────────────────────────────────────────────────

let rejected: ((where: "http" | "ws") => void) | null = null;

/** Register the one handler for "the host refused this phone's token"
 *  (`lanLink.ts`: drop it, back to the tailnet, re-mint once). */
export function onBearerRejected(fn: ((where: "http" | "ws") => void) | null): void {
  rejected = fn;
}

/** A request that CARRIED the token came back 401. */
export function noteBearerRejected(where: "http" | "ws"): void {
  try { rejected?.(where); } catch { /* the handler's own problem */ }
}
