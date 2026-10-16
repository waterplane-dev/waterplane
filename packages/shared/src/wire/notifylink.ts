/**
 * The Android background link: a socket that is only there to raise alerts.
 *
 * The APK's native `ShellLinkService` holds its own WebSocket so notifications
 * arrive with the app closed, and acts on exactly three inbound frames. Every
 * other frame the host sends it wakes the phone's radio and CPU only to be
 * thrown away — and that socket never sleeps. So the host marks it, and sends
 * it the allow-list below and nothing else (`server/clients.ts`'s `send`).
 *
 * Two ways a socket becomes one, the explicit one winning:
 * - `hello.role: "notify"` (an APK built after 2026-10-13);
 * - a `User-Agent` starting `okhttp/` at the upgrade — the WebView sends a
 *   Chrome UA, OkHttp its own. That is what covers every APK already installed,
 *   which says nothing about its role and does not update with the bundle.
 */

/** The one role a socket may declare today. Absent ⇒ a full client. */
export type ClientRole = "notify";

/**
 * What a notify link is sent. The three `ShellLinkService.onFrame` reads, plus
 * `pong` — sent only when the socket ASKED with `{t:"ping"}`, so a link that
 * keeps a JSON heartbeat is not torn down for lack of an answer. No
 * `notification.list`: the service posts each `notification` as it comes and
 * dedupes by tag; it never replays a feed.
 */
export const NOTIFY_LINK_FRAMES: ReadonlySet<string> = new Set(["notification", "authRequired", "pull.new", "pong"]);

/** The client frames a notify link may send. Anything else (an attach above
 *  all) is ignored, so the link can never count as somebody watching. */
export const NOTIFY_LINK_INBOUND: ReadonlySet<string> = new Set(["hello", "ping"]);

/** May a socket in this role be sent a frame of this type? */
export function roleAllows(role: ClientRole | undefined, t: string): boolean {
  return role !== "notify" || NOTIFY_LINK_FRAMES.has(t);
}

/** May a socket in this role send this client frame? */
export function roleAccepts(role: ClientRole | undefined, t: string): boolean {
  return role !== "notify" || NOTIFY_LINK_INBOUND.has(t);
}

/** The role guessed at upgrade, before any frame: OkHttp is the native link. */
export function roleFromUserAgent(ua: string | string[] | undefined): ClientRole | undefined {
  const s = Array.isArray(ua) ? ua[0] : ua;
  return typeof s === "string" && /^okhttp\//i.test(s) ? "notify" : undefined;
}

/** The role after `hello`: an explicit one wins, else whatever the upgrade said. */
export function roleAfterHello(declared: unknown, upgraded: ClientRole | undefined): ClientRole | undefined {
  return declared === "notify" ? "notify" : upgraded;
}
