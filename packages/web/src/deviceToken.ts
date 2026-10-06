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
 */
import { BRAND } from "@waterplane/shared";
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

export function deviceToken(): string | null {
  const t = lsGet(LS.deviceToken);
  return validToken(t) ? t : null;
}

export function setDeviceToken(tok: string): void {
  if (validToken(tok)) lsSet(LS.deviceToken, tok);
}

export function dropDeviceToken(): void {
  lsDel(LS.deviceToken);
}

/** The `Authorization` value for a request to `url`, or null. Only when `url`
 *  is on the same ORIGIN as `base` (the host base in force right now). */
export function bearerFor(url: string, base: string | null, tok: string | null): string | null {
  if (!tok || !base) return null;
  try {
    return new URL(url).origin === new URL(base).origin ? `Bearer ${tok}` : null;
  } catch {
    return null;
  }
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
