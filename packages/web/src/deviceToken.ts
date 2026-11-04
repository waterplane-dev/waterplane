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
 */
import { BRAND, parkedKeyFor } from "@waterplane/shared";
import { LS, lsDel, lsGet, lsSet } from "./storage.ts";

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
export function holdTokens(tokens: Readonly<Record<string, string>>): void {
  for (const [id, t] of Object.entries(tokens)) if (validToken(t) && !held.has(id)) held.set(id, t);
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

/** Empty the map (the mode went off, its tokens are back in storage). */
export function releaseTokens(): void {
  held.clear();
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
