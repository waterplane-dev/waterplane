/**
 * What this phone is called, and what model it is — read by pairing
 * (`PairForm.tsx`, `lanLink.ts`) and, through `@waterplane/sdk`, by the extension that keeps the
 * install log. Core's own install-log module is gone (P4); this is the half core still needs.
 */
import { lsGet, lsSet, LS } from "./storage";

/** What this phone is called in the log. Empty = nobody has named it, and the
 *  log then falls back to the model and finally to a shortened id
 *  (the android-apps extension's `deviceLabel`, `shared/wire.mts`) — never to a blank. */
export function deviceName(): string {
  return (lsGet(LS.deviceName) ?? "").trim();
}

/** Name this phone — the one name pairing and the install log both read (`LS.deviceName`). Trimmed,
 *  at most 60 characters. Reaches extensions as `@waterplane/sdk`'s `setDeviceName`. */
export function setDeviceName(name: string): void {
  lsSet(LS.deviceName, name.trim().slice(0, 60));
}

/**
 * The phone's model, off the user agent.
 *
 * A best effort and labelled as one: Android puts the model in the UA
 * (`… Linux; Android 14; Pixel 8 Build/…`), and nothing else here does. A UA
 * this cannot read yields NOTHING rather than a guess — `deviceLabel` then says
 * `device a1b2c3`, which is honest, where "Mozilla" would not be.
 */
export function deviceModel(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const m = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?\s*\)/.exec(ua);
  const model = (m?.[1] ?? "").trim();
  // "K" is what Chrome's UA reduction puts there when it refuses to say. A
  // one-letter model is not a model.
  return model.length > 1 ? model.slice(0, 60) : "";
}
