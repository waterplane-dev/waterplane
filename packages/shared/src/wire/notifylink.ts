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

/** A socket's role. Absent ⇒ a full client. `notify` is the APK's background
 *  link (declared, or guessed off the User-Agent); `relay` is never declared by
 *  anybody — it is the host's own stand-in socket behind `POST /api/relay`
 *  (`host/src/server/relay.ts`), so `roleAfterHello` never grants it. */
export type ClientRole = "notify" | "relay";

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
export const NOTIFY_LINK_INBOUND: ReadonlySet<string> = new Set(["hello", "ping", "link.log"]);

/** One thing the phone's background link saw, on the PHONE's clock (ms): `ev` a short
 *  lower-case word (`dial`, `open`, `fail`, `closed`, `retry`, `wake`, `net-up`, `net-lost`,
 *  `alert`), `d` an optional detail. The APK keeps a ring of these while the link is down
 *  and sends them in one `link.log` frame on each reconnect (`host/src/linklog.ts`). */
export interface LinkLogEvent { at: number; ev: string; d?: string }

/** At most this many events per frame; the APK's ring holds no more. */
export const LINK_LOG_MAX_EVENTS = 300;
const LINK_LOG_EV_RE = /^[a-z][a-z-]{0,15}$/;
const LINK_LOG_DETAIL_MAX = 160;

/**
 * A `link.log` frame's events, kept only where every field has its shape, with `at` moved
 * onto the HOST's clock: the phone stamps `sentAt` at the write, so `hostNow - sentAt`
 * (transit included, a fraction of a second) is the skew. No usable `sentAt` ⇒ `skewMs` 0 and
 * the phone's own times. An unknown word is kept: an APK newer than this host may say more.
 */
export function cleanLinkLog(raw: unknown, sentAt: unknown, hostNow: number): { skewMs: number; events: LinkLogEvent[] } {
  const skewMs = typeof sentAt === "number" && Number.isFinite(sentAt) && sentAt > 0 ? Math.round(hostNow - sentAt) : 0;
  const events: LinkLogEvent[] = [];
  if (!Array.isArray(raw)) return { skewMs, events };
  for (const e of raw.slice(-LINK_LOG_MAX_EVENTS)) {
    if (!e || typeof e !== "object") continue;
    const { at, ev, d } = e as Record<string, unknown>;
    if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) continue;
    if (typeof ev !== "string" || !LINK_LOG_EV_RE.test(ev)) continue;
    const out: LinkLogEvent = { at: at + skewMs, ev };
    if (typeof d === "string" && d) out.d = d.slice(0, LINK_LOG_DETAIL_MAX);
    events.push(out);
  }
  return { skewMs, events };
}

/** What the relay's stand-in socket is sent: the three receipts a relayed
 *  frame can earn, nothing else (no toast, no snapshot, no PTY bytes). */
export const RELAY_LINK_FRAMES: ReadonlySet<string> = new Set(["input.ack", "backlog.ack", "op.ack"]);

/** May a socket in this role be sent a frame of this type? */
export function roleAllows(role: ClientRole | undefined, t: string): boolean {
  if (role === "notify") return NOTIFY_LINK_FRAMES.has(t);
  if (role === "relay") return RELAY_LINK_FRAMES.has(t);
  return true;
}

/** May a socket in this role send this client frame? A relay socket's frame has
 *  already passed `relayRefusal` (`queue/queuerelay.ts`), the one accept rule. */
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
