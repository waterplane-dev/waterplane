/**
 * Passive devices — the kids' phone (R-connection-011…014). Security boundary:
 * described in docs/notes/protocol-and-security.md, never a skill.
 *
 * **The allowlist is default-deny.** A passive token (a `DeviceRow.scope ===
 * "passive"` row that is not currently unlocked) reaches only what
 * `passiveAllows` names: health, the web bundle the OTA update reads, the
 * passive screen's own state, the theme, and the artifact download of an APK
 * the auto-pull queue holds RIGHT NOW — not any file of any repo. A route added
 * anywhere else in the host is refused to a passive token until somebody adds
 * it here on purpose. The WebSocket is refused outright (`server/wsops.ts`), and
 * `/api/auth/token` will not mint a full token for one (`server/http.ts`).
 *
 * **The PIN** is scrypt-hashed in `<STATE_DIR>/passive-pin.json` (0600), set
 * only from a trusted caller that is not itself passive (unlocked or not), and
 * checked here, rate-limited per device. A correct PIN lifts THAT device to
 * full scope for `unlockMs` — in this process's memory only, so a host restart
 * comes back locked too — and a timer closes the device's sockets when it runs
 * out, so an open WebSocket does not outlive the unlock.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  PASSIVE_UNLOCK_MS, isPassiveItem, normalizePin, passiveUnlockErrorText,
  type DeviceRow, type PassiveUnlockResponse, type PullItem,
} from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";
import { RateLimiter } from "./ratelimit.js";
import { env } from "./env.js";

/** `WATERPLANE_PASSIVE_UNLOCK_MS` shortens the unlock for e2e (floored at 1 s,
 *  never longer than the 30 minutes the phone's sentence promises). */
export function unlockMsFromEnv(): number {
  const n = Number(env("PASSIVE_UNLOCK_MS"));
  return Number.isFinite(n) && n > 0 ? Math.min(PASSIVE_UNLOCK_MS, Math.max(1000, n)) : PASSIVE_UNLOCK_MS;
}

const READ = new Set(["GET", "HEAD"]);
/** Exact read-only paths a passive token may ask. Adding one is a decision. */
const PASSIVE_READS = new Set(["/api/health", "/api/webbundle", "/api/webbundle/file", "/api/passive/state", "/api/theme"]);
const ARTIFACT = /^\/api\/repos\/([^/]+)\/artifact$/;

/**
 * May a passive (locked) token make this `/api/` request? `queuedApk` answers
 * "is (repoId, worktree-relative path) an APK in the auto-pull queue". Pure:
 * `packages/host/test/passive.test.mjs` asks it directly.
 */
export function passiveAllows(
  method: string, path: string, query: URLSearchParams, queuedApk: (repoId: string, relPath: string) => boolean,
): boolean {
  if (!READ.has(method.toUpperCase())) return false;
  if (PASSIVE_READS.has(path)) return true;
  const m = ARTIFACT.exec(path);
  if (!m) return false;
  let repoId: string;
  try { repoId = decodeURIComponent(m[1]!); } catch { return false; }
  const rel = query.get("path");
  return !!rel && queuedApk(repoId, rel);
}

/** The auto-pull queue as a passive device may see it: APKs only. */
export function passiveItems(items: readonly PullItem[]): PullItem[] {
  return items.filter(isPassiveItem);
}

/** `passiveAllows`'s question over a queue. */
export function queuedApkIn(items: readonly PullItem[]): (repoId: string, relPath: string) => boolean {
  return (repoId, relPath) => items.some((i) => isPassiveItem(i) && i.repoId === repoId && i.relPath === relPath);
}

interface StoredPin { salt: string; hash: string }

export interface PassiveGateOpts {
  now?: () => number;
  unlockMs?: number;
  /** A device's unlock ended (expiry or "Lock now"): close its sockets. */
  onRelock?: (deviceId: string) => void;
}

export type UnlockResult = PassiveUnlockResponse & { retryAfterMs?: number };

export class PassiveGate {
  readonly file: string;
  private pin: StoredPin | null;
  private readonly unlocked = new Map<string, { until: number; timer: ReturnType<typeof setTimeout> }>();
  private readonly now: () => number;
  readonly unlockMs: number;
  /** Set by `main.ts` once the socket registry exists (`closeDevice`). */
  onRelock: (id: string) => void;
  /** 5 tries in a burst, then one a minute, per device: a 4-digit PIN takes
   *  days to walk, a child mistyping twice is never locked out. */
  private readonly limit = new RateLimiter({ burst: 5, perSec: 1 / 60 });

  constructor(root: string, opts: PassiveGateOpts = {}) {
    this.file = join(hostStateDir(root), "passive-pin.json");
    this.now = opts.now ?? Date.now;
    this.unlockMs = opts.unlockMs ?? unlockMsFromEnv();
    this.onRelock = opts.onRelock ?? (() => undefined);
    const ok = (v: unknown) => !!v && typeof (v as StoredPin).salt === "string" && typeof (v as StoredPin).hash === "string";
    this.pin = readJsonGuarded<StoredPin | null>(this.file, null, ok);
  }

  pinSet(): boolean { return !!this.pin; }

  /** Set (a valid PIN) or clear (`null`) the unlock PIN. Every live unlock ends. */
  setPin(raw: string | null): void {
    if (raw === null) {
      this.pin = null;
      try { rmSync(this.file, { force: true }); } catch { /* nothing to remove */ }
    } else {
      const pin = normalizePin(raw);
      if (!pin) throw new Error(passiveUnlockErrorText("bad-request"));
      const salt = randomBytes(16).toString("hex");
      this.pin = { salt, hash: scryptSync(pin, salt, 32).toString("hex") };
      writeJsonAtomic(this.file, this.pin, { mode: 0o600 });
    }
    for (const id of [...this.unlocked.keys()]) this.lock(id);
  }

  private pinMatches(pin: string): boolean {
    if (!this.pin) return false;
    const got = scryptSync(pin, this.pin.salt, 32);
    const want = Buffer.from(this.pin.hash, "hex");
    return got.length === want.length && timingSafeEqual(got, want);
  }

  /** A passive device asks to be lifted to full scope. */
  unlock(row: DeviceRow | null, raw: unknown): UnlockResult {
    const fail = (error: Exclude<PassiveUnlockResponse, { ok: true }>["error"], retryAfterMs = 0): UnlockResult =>
      ({ ok: false, error, message: passiveUnlockErrorText(error, retryAfterMs / 1000), ...(retryAfterMs ? { retryAfterMs } : {}) });
    if (!row || row.scope !== "passive") return fail("not-passive");
    if (!this.pin) return fail("no-pin");
    const now = this.now();
    if (!this.limit.take(row.id, now)) return fail("rate-limited", Math.max(1000, this.limit.retryAfterMs(row.id, now)));
    const pin = normalizePin(raw);
    if (!pin) return fail("bad-request");
    if (!this.pinMatches(pin)) return fail("wrong-pin");
    this.lock(row.id, false);
    const until = now + this.unlockMs;
    const timer = setTimeout(() => this.lock(row.id), this.unlockMs);
    timer.unref?.();
    this.unlocked.set(row.id, { until, timer });
    return { ok: true, unlockedUntil: until };
  }

  /** End a device's unlock ("Lock now", expiry, a PIN change). */
  lock(id: string, notify = true): boolean {
    const u = this.unlocked.get(id);
    if (!u) return false;
    clearTimeout(u.timer);
    this.unlocked.delete(id);
    if (notify) this.onRelock(id);
    return true;
  }

  /** Until when this device is unlocked, or null. The clock decides, not the timer. */
  unlockedUntil(id: string | null | undefined): number | null {
    if (!id) return null;
    const u = this.unlocked.get(id);
    if (!u) return null;
    if (u.until <= this.now()) { this.lock(id); return null; }
    return u.until;
  }

  /** Is this row a passive token that is NOT unlocked right now? */
  restricted(row: DeviceRow | null | undefined): boolean {
    return !!row && row.scope === "passive" && this.unlockedUntil(row.id) === null;
  }
}
