/**
 * Web Push (VAPID) so the phone gets notified — even with the app backgrounded
 * or closed — when a session needs a Yes/No, finishes its turn, or a backlog
 * item completes. iOS supports this only for an installed (Add-to-Home-Screen)
 * PWA on 16.4+.
 *
 * Keys and subscriptions persist under <STATE_DIR> so they survive restarts.
 */
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJsonGuarded, readJsonGuardedDetail, writeJsonAtomic } from "./jsonstore.js";
import webpush, { type PushSubscription } from "web-push";
import { env } from "./env.js";
import { BRAND, type NotifyLevel, type NotifyOpen } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";

export interface PushPayload {
  title: string;
  body: string;
  /** Optional session id to focus when the notification is tapped. */
  sessionId?: string;
  tag?: string;
  /** When set, tapping opens this image straight into the annotator. */
  image?: { repoId: string; relPath: string };
  /** When set, tapping downloads this artifact (outbox file). */
  file?: { repoId: string; relPath: string; name: string; size: number; mtime?: number };
  /**
   * Auto-download: the pull-queue id this notification is about. The service
   * worker treats its presence as "start fetching `file` now" rather than "wait
   * for a tap" — which is the whole point of auto-pull, since the app is
   * normally closed when the artifact lands. The notification still shows.
   */
  pull?: string;
  /** Id of the plugin that posted this; a tap opens that plugin's screen. */
  plugin?: string;
  /** The feed item's own id, kind and stamp, so the service worker can hand a
   *  tapped alert back to the page whole (`openNotif`). */
  id?: string;
  kind?: string;
  ts?: number;
  /** A backlog cut to open (`NotificationItem.backlog`). */
  backlog?: { cwd: string; ids: string[] };
  /** The screen a tap opens (`NotificationItem.open`). */
  open?: NotifyOpen;
  /** `attention` or `info` (`notifyLevel`), so the service worker can word or
   *  channel the two apart. Only attention is pushed unless the person asked for
   *  information too (`notify.prefs`' `pushInfo`) or the payload carries `pull`. */
  level?: NotifyLevel;
  /** The attention item's cause key (`NotificationItem.key`). */
  key?: string;
}

/**
 * What a push may weigh, as JSON bytes. RFC 8030 has a push service accept 4096 bytes of
 * encrypted record; aes128gcm's header and tag take ~100 of them, so 3800 leaves room. Past the
 * limit a service answers 413 and the notification is lost — so the payload is cut BEFORE it goes.
 */
export const PUSH_BUDGET = 3800;
/** The retry after a 413: a service with a smaller limit still gets the title and the item's ids. */
export const PUSH_FLOOR = 1024;

const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");

/** The tap targets a payload may lose when it cannot fit otherwise. Never `id`/`kind` (the service
 *  worker's `notifItem` hands a tap back to the page's feed row by them), `ts`, `level`, nor the
 *  words (cut instead). Without one of these a tap degrades to that feed row, which holds the item. */
const DROPPABLE = ["file", "pull", "image", "backlog", "open", "key", "plugin", "sessionId", "tag"] as const;
type Droppable = (typeof DROPPABLE)[number];

/** The words of a payload fitted to `budget`: the JSON whole, else the body (then the title) cut
 *  by code point with a trailing "…" to the longest that fits; null when even an empty body and a
 *  bare "…" title are over. */
function fitWords(payload: PushPayload, budget: number): string | null {
  const whole = JSON.stringify(payload);
  if (byteLen(whole) <= budget) return whole;
  const cut = (s: string, n: number): string => { const cps = Array.from(s); return cps.length <= n ? s : cps.slice(0, n).join("") + "…"; };
  const longest = (field: "body" | "title", base: PushPayload): PushPayload => {
    const cps = Array.from(base[field]).length;
    let lo = 0, hi = cps;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (byteLen(JSON.stringify({ ...base, [field]: cut(base[field], mid) })) <= budget) lo = mid; else hi = mid - 1;
    }
    return { ...base, [field]: cut(base[field], lo) };
  };
  const bodyCut = longest("body", payload);
  if (byteLen(JSON.stringify(bodyCut)) <= budget) return JSON.stringify(bodyCut);
  const t = JSON.stringify(longest("title", { ...bodyCut, body: "" }));
  return byteLen(t) <= budget ? t : null;
}

/**
 * The ONE place a push payload is fitted to a size. First the words are cut (`fitWords`); every
 * other field — id, kind, key, file, pull — is kept, because the service worker hands the item back
 * to the page by them and the full words are in the app's feed. When the KEPT fields alone are over
 * the budget (a multi-KB `file.relPath` or `key`), the longest optional tap target is dropped — and
 * `pull` with `file`, since a pull without its file cannot start — until it fits, the words
 * re-fitted each time so a field that went never cost them a character. A payload that cannot fit
 * even then is `text: null`: never sent, because a service answers an over-budget push with 413.
 */
export function pushPayloadFit(payload: PushPayload, budget: number): { text: string | null; dropped: Droppable[] } {
  let p: PushPayload = payload;
  const dropped: Droppable[] = [];
  for (;;) {
    const text = fitWords(p, budget);
    if (text !== null) return { text, dropped };
    const rec = p as unknown as Record<string, unknown>;
    let worst: Droppable | null = null, worstLen = 0;
    for (const f of DROPPABLE) {
      if (rec[f] === undefined) continue;
      const len = byteLen(JSON.stringify(rec[f]));
      if (len > worstLen) { worst = f; worstLen = len; }
    }
    if (worst === null) return { text: null, dropped };
    const gone: Droppable[] = worst === "file" && rec.pull !== undefined ? ["file", "pull"] : [worst];
    const next = { ...rec };
    for (const f of gone) delete next[f];
    p = next as unknown as PushPayload;
    dropped.push(...gone);
  }
}

/** `pushPayloadFit`'s text alone: null when nothing that fits can be sent. */
export function pushPayloadText(payload: PushPayload, budget: number): string | null {
  return pushPayloadFit(payload, budget).text;
}

/** How long the same refusal from the same subscription stays quiet after it was logged once. */
export const PUSH_REPEAT_LOG_MS = 60 * 60_000;

/**
 * The ONE rule for a push service's refusal. `gone`: 404/410, the service says the subscription
 * expired or was unsubscribed — removed at once. `key-refused`: 401/403, the service rejected the
 * VAPID token THIS DESKTOP signed — almost always the host's own fault (clock skew past the token's
 * 12 h, a `VAPID_CONTACT` the service will not take, an older vapid.json restored) and healed by
 * fixing it, so it is COUNTED and the subscription removed only when the refusal persists
 * (`PUSH_KEY_REFUSAL_COUNT` refusals spanning `PUSH_KEY_REFUSAL_SPAN_MS`): the phone keeps showing
 * "on" and nothing re-posts a removed subscription. A refusal whose own `Date` header shows the
 * host's clock off by more than `PUSH_CLOCK_SKEW_MS` is not counted at all (`pushClockSkewMs`). `too-large`: 413, resent smaller once.
 * `transient`: everything else — 429, 5xx, 400, a network error with no status — kept, next notify tries.
 */
export function pushRefusal(statusCode: unknown): "gone" | "key-refused" | "too-large" | "transient" {
  if (statusCode === 404 || statusCode === 410) return "gone";
  if (statusCode === 401 || statusCode === 403) return "key-refused";
  if (statusCode === 413) return "too-large";
  return "transient";
}

/** A key refusal removes the subscription only once it has happened this many times… */
export const PUSH_KEY_REFUSAL_COUNT = 3;
/** …and the first and latest of them are at least this far apart. */
export const PUSH_KEY_REFUSAL_SPAN_MS = 24 * 60 * 60_000;

/** A stored subscription, with the key refusals counted against it (persisted in push-subs.json, so
 *  a restart neither forgets nor restarts the count; cleared by any successful send). */
type StoredSub = PushSubscription & { keyRefused?: { first: number; count: number } };

/** How far this host's clock may sit from the push service's before a key refusal is blamed on the
 *  clock rather than the subscription. The VAPID JWT's `exp` is the host's now + 12 h, so a host
 *  clock off by more than that is refused on every send, for as long as the clock stays wrong. */
export const PUSH_CLOCK_SKEW_MS = 10 * 60_000;

/**
 * How far the push service's clock is from this host's, in ms (service − host), read off the
 * refusal's own `Date` response header (web-push's `WebPushError.headers`); null when the error
 * carries no parseable Date — then nobody said, and the refusal is judged as before.
 */
export function pushClockSkewMs(err: unknown, now: number): number | null {
  const headers = (err as { headers?: unknown } | null)?.headers;
  if (!headers || typeof headers !== "object") return null;
  const raw = (headers as Record<string, unknown>).date ?? (headers as Record<string, unknown>).Date;
  if (typeof raw !== "string") return null;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at - now : null;
}

/** The push service's host, for a log line (never the endpoint's secret path). */
function endpointHost(endpoint: string): string {
  try { return new URL(endpoint).host; } catch { return "a push service"; }
}

export class PushManager {
  private subs: StoredSub[] = [];
  private keys: { publicKey: string; privateKey: string };
  private subsPath: string;
  private keysPath: string;
  private now: () => number;

  constructor(root: string, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    const dir = hostStateDir(root);
    this.subsPath = join(dir, "push-subs.json");
    this.keysPath = join(dir, "vapid.json");
    mkdirSync(dir, { recursive: true });

    // Guarded: a truncated vapid.json used to throw out of this constructor and
    // take the whole daemon down at boot. A corrupt file is moved aside
    // (`jsonstore.ts`) and a fresh pair minted — written atomically and 0600,
    // because the private key is a secret.
    const isKeys = (v: unknown): boolean =>
      !!v && typeof (v as { publicKey?: unknown }).publicKey === "string" && typeof (v as { privateKey?: unknown }).privateKey === "string";
    const read = readJsonGuardedDetail<{ publicKey: string; privateKey: string } | null>(this.keysPath, null, isKeys);
    let regenerated = false;
    if (read.value) {
      this.keys = read.value;
      // A key file written before this was 0600 keeps its old, wider mode
      // otherwise; tighten it in place (best effort, never fatal).
      try { if ((statSync(this.keysPath).mode & 0o077) !== 0) chmodSync(this.keysPath, 0o600); } catch { /* best effort */ }
    } else {
      this.keys = webpush.generateVAPIDKeys();
      regenerated = !!read.corrupt;
      try { writeJsonAtomic(this.keysPath, this.keys, { mode: 0o600, space: 2 }); } catch (e) {
        console.error(`[push] could not save VAPID keys (${(e as Error).message}); push works until restart`);
      }
    }
    // Some push services (notably some FCM/APNs-fronting endpoints) reject a
    // non-resolvable VAPID contact like `mailto:waterplane@localhost`. Default to a
    // valid-looking placeholder; override with a real address via env.
    const vapidContact = env("VAPID_CONTACT") || `mailto:${BRAND.slug}@example.com`;
    webpush.setVapidDetails(vapidContact, this.keys.publicKey, this.keys.privateKey);

    this.subs = readJsonGuarded<StoredSub[]>(this.subsPath, [], Array.isArray);
    if (regenerated && this.subs.length) {
      // Every stored subscription was made against the LOST public key and can
      // never be delivered to again; each phone re-subscribes when it next opens.
      console.error(`[push] VAPID keys were regenerated; dropping ${this.subs.length} subscription(s) bound to the old key`);
      this.subs = [];
      this.save();
    }
  }

  get publicKey(): string {
    return this.keys.publicKey;
  }

  subscribe(sub: PushSubscription): void {
    if (!sub?.endpoint) return;
    if (this.subs.some((s) => s.endpoint === sub.endpoint)) return;
    this.subs.push(sub);
    this.save();
  }

  unsubscribe(endpoint: string): void {
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    this.save();
  }

  async notify(payload: PushPayload): Promise<void> {
    const dead: string[] = [];
    let changed = false;
    // One rule for every refusal, first send and retry alike (`pushRefusal`).
    const refused = (sub: StoredSub, where: string, err: any, again: boolean): void => {
      const code = err?.statusCode;
      const kind = pushRefusal(code);
      if (kind === "gone") { dead.push(sub.endpoint); return; } // routine expiry, no line
      if (kind === "key-refused") {
        const now = this.now();
        // The service's own clock says this host's is wrong: the token was refused for the HOST's
        // clock, never the subscription's fault, so it is not counted toward removal.
        const skew = pushClockSkewMs(err, now);
        if (skew !== null && Math.abs(skew) > PUSH_CLOCK_SKEW_MS) {
          if (!this.logOnce(`${sub.endpoint}\0skew`)) return;
          const min = Math.round(Math.abs(skew) / 60_000);
          console.warn(`[push] ${where} refused this desktop's key (${code}) for "${payload.title}", and its clock is ${min} min ${skew > 0 ? "ahead of" : "behind"} this desktop's — the key is signed with this desktop's clock, so fix the clock; not counted against the subscription`);
          return;
        }
        const r = sub.keyRefused ?? { first: now, count: 0 };
        r.count++;
        sub.keyRefused = r;
        changed = true;
        if (r.count >= PUSH_KEY_REFUSAL_COUNT && now - r.first >= PUSH_KEY_REFUSAL_SPAN_MS) {
          dead.push(sub.endpoint);
          console.warn(`[push] ${where} has refused this desktop's key (${code}) ${r.count} times over ${Math.round((now - r.first) / 3_600_000)} h; removing that subscription — the phone must re-enable notifications to get them again`);
          return;
        }
        if (!this.logOnce(`${sub.endpoint}\0key`)) return;
        console.warn(`[push] ${where} refused this desktop's key (${code}) for "${payload.title}" — counting it (${r.count} so far); the subscription is removed only if this persists ${PUSH_KEY_REFUSAL_COUNT} times over ${PUSH_KEY_REFUSAL_SPAN_MS / 3_600_000} h. Usually the host's own fault: check the clock, VAPID_CONTACT, or a restored vapid.json; the next successful send clears the count`);
        return;
      }
      // Keyed and worded by status or error code, never the message: a network error's message
      // names an address that changes per attempt, which defeated the hourly limit.
      const why = code ?? err?.code ?? "network error";
      if (!this.logOnce(`${sub.endpoint}\0${why}`)) return;
      console.warn(`[push] ${where} refused "${payload.title}"${again ? " again" : ""} (${why}); the item is in the app's feed`);
    };
    const sent = (sub: StoredSub): void => {
      if (sub.keyRefused) { delete sub.keyRefused; changed = true; }
    };
    // Fitted once per notify, and said once: a payload known to be over budget never goes out.
    const fitted = (budget: number): string | null => {
      const { text, dropped } = pushPayloadFit(payload, budget);
      if (text === null) console.warn(`[push] "${payload.title}" cannot fit a push's ${budget} bytes even with its words cut and its tap targets dropped; not sent — the item is in the app's feed`);
      else if (dropped.length) console.warn(`[push] "${payload.title}" is over a push's ${budget} bytes even with its words cut; sent without its ${dropped.join(", ")} — a tap opens the item in the app's feed`);
      return text;
    };
    if (!this.subs.length) return;
    const whole = fitted(PUSH_BUDGET);
    if (whole === null) return;
    let floor: string | null | undefined;
    await Promise.all(
      this.subs.map(async (sub) => {
        const where = endpointHost(sub.endpoint);
        try {
          await webpush.sendNotification(sub, whole);
          sent(sub);
        } catch (err: any) {
          if (pushRefusal(err?.statusCode) !== "too-large") { refused(sub, where, err, false); return; }
          // 413: this service's limit is under our budget. Once more, cut to the floor.
          if (floor === undefined) floor = fitted(PUSH_FLOOR);
          if (floor === null) return;
          const small = floor;
          console.warn(`[push] ${where} answered 413 to "${payload.title}"; resending cut to ${Buffer.byteLength(small, "utf8")} bytes`);
          try { await webpush.sendNotification(sub, small); sent(sub); } catch (e: any) { refused(sub, where, e, true); }
        }
      }),
    );
    if (dead.length) this.subs = this.subs.filter((s) => !dead.includes(s.endpoint));
    if (dead.length || changed) this.save();
  }

  /** When each (subscription, refusal) was last logged — a transient refusal that repeats on every
   *  notify is one line per `PUSH_REPEAT_LOG_MS`, not one per notify. Entries past the window are
   *  pruned on every call, so it holds at most what was logged within the last window. */
  private lastLogged = new Map<string, number>();
  private logOnce(key: string): boolean {
    const now = this.now();
    for (const [k, t] of this.lastLogged) if (now - t >= PUSH_REPEAT_LOG_MS) this.lastLogged.delete(k);
    const at = this.lastLogged.get(key);
    if (at !== undefined && now - at < PUSH_REPEAT_LOG_MS) return false;
    this.lastLogged.set(key, now);
    return true;
  }

  private save(): void {
    try { writeJsonAtomic(this.subsPath, this.subs, { space: 2 }); } catch { /* non-fatal */ }
  }
}
