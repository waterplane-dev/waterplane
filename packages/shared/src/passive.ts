/**
 * Passive device mode — the kids' phone (requirements R-connection-011…014).
 *
 * A device paired as "passive" holds a token the host lets through only to the
 * app-update path: health, the web bundle, `GET /api/passive/state` and the
 * artifact download of an APK the auto-pull queue holds. Everything else, the
 * WebSocket included, is refused by the HOST (`host/src/passive.ts`); the
 * phone's single screen is a courtesy, never the boundary.
 *
 * A PIN, checked and rate-limited on the host, lifts that one token to full
 * scope for `PASSIVE_UNLOCK_MS`. The lift lives in the host's memory only, so a
 * killed app, a reboot of the phone or a host restart all come back locked.
 */
import type { PullItem } from "./wire/work.js";

/** How long a correct PIN unlocks a passive device. */
export const PASSIVE_UNLOCK_MS = 30 * 60_000;
export const PIN_MIN = 4;
export const PIN_MAX = 12;

/** A PIN as typed: digits only, `PIN_MIN`–`PIN_MAX` long; `null` otherwise. */
export function normalizePin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  return new RegExp(`^[0-9]{${PIN_MIN},${PIN_MAX}}$`).test(s) ? s : null;
}

/** `GET /api/auth/status` adds these for a caller holding a device token. */
export interface PassiveAuthFields {
  /** The caller's token is a passive one. Absent ⇒ full scope. */
  scope?: "passive";
  /** A passive token currently unlocked by the PIN: until when (epoch ms). */
  unlockedUntil?: number;
  /** An unlock PIN is set on this host. */
  pinSet?: boolean;
}

/** `GET /api/passive/state` → what the passive screen draws. */
export interface PassiveStateResponse {
  /** The APKs the auto-pull queue holds — exactly the downloads a passive token may fetch. */
  items: PullItem[];
  /** The host's clock when it answered: the "last check" line. */
  checkedAt: number;
  /** Unlocked until (epoch ms), or null when locked / not passive. */
  unlockedUntil: number | null;
  pinSet: boolean;
}

/** `POST /api/auth/unlock {pin}` → */
export type PassiveUnlockResponse =
  | { ok: true; unlockedUntil: number }
  | { ok: false; error: "not-passive" | "no-pin" | "wrong-pin" | "rate-limited" | "bad-request"; message: string };

/** The one wording of a refusal of an unlock. */
export function passiveUnlockErrorText(error: Exclude<PassiveUnlockResponse, { ok: true }>["error"], retryAfterS = 0): string {
  switch (error) {
    case "not-passive": return "This device is not a passive device, so there is nothing to unlock.";
    case "no-pin": return "No unlock PIN is set on the desktop. Set one from a trusted phone: Settings › Connection › Passive devices.";
    case "wrong-pin": return "Wrong PIN.";
    case "rate-limited": return `Too many tries. Try again in ${Math.max(1, Math.ceil(retryAfterS / 60))} min.`;
    case "bad-request": return `A PIN is ${PIN_MIN}–${PIN_MAX} digits.`;
    // `error` is the host's answer: a refusal a newer host adds reaches an
    // older phone with no case for it.
    default: return "The desktop refused the unlock for a reason this app version cannot name.";
  }
}

/** The item a passive screen and a passive download both mean: an APK. */
export function isPassiveItem(item: Pick<PullItem, "name" | "relPath">): boolean {
  return /\.apk$/i.test(item.name) || /\.apk$/i.test(item.relPath);
}

/** "Unlocked until 14:35" — the clock is the phone's, at render. */
export function unlockedUntilText(until: number, now = Date.now()): string | null {
  if (!(until > now)) return null;
  const d = new Date(until);
  const p = (n: number) => String(n).padStart(2, "0");
  return `Unlocked until ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The pairing sheet's one sentence about what a passive pairing switches on. */
export const PASSIVE_PAIR_NOTE =
  "Pairing a passive device switches on \"require the password over Tailscale\", so every device needs its own token on Tailscale too — sign in again on any browser that has none.";
