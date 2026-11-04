/**
 * The app lock's decisions, pure: when the screen locks, which of the two ways
 * of asking this shell can do, what a refusal means and how it is worded.
 *
 * The lock FAILS CLOSED. A refusal opens the app only where a person holding
 * the phone could not have caused it: a key the phone's own credential had to
 * invalidate, a blob only this app writes, or a phone that a FRESH status read
 * confirms has nothing left to check with. Everything else stays locked at any
 * repeat count, and a code this file has never heard of stays too. There is no
 * failure counter on purpose: `failed` is the shell's default branch, so it
 * holds errors a wet finger can produce.
 *
 * Nothing here reads the DOM or the phone. `features/appLock` drives it.
 */
import { BRAND } from "@waterplane/shared";

/** Away for longer than this and the screen locks when the person comes back. */
export const APP_LOCK_GRACE_MS = 60_000;

/** The sentinel path's Keystore alias; nothing else on this phone uses it. */
export const APP_LOCK_ALIAS = `${BRAND.slug}.applock`;

/** What the sheet says when the lock asks to be opened. */
export const UNLOCK_PROMPT = { title: `Unlock ${BRAND.name}` };

/** The sheet's words when the lock is turned on or off from Settings. */
export const lockSwitchPrompt = (on: boolean) => ({ title: `Lock ${BRAND.name}`, subtitle: `Confirm it's you to turn the lock ${on ? "on" : "off"}` });

/** Where a person turns the lock back on, exactly as the row is drawn. */
export const APP_LOCK_WAY_BACK = "Settings › Connection › lock this app turns it back on.";

/** The one toast when the switch is on but this shell cannot lock. */
export const NO_KEYSTORE_WORDS = "This app has no fingerprint keystore, so the app lock is off.";

/**
 * `authenticate`: the shell's keyless prompt, which also offers the phone's PIN.
 * `sentinel`: today's APK, an `unwrap` of random bytes behind the fingerprint sheet.
 */
export type LockPath = "authenticate" | "sentinel";

/** By feature, never by version: the UI updates over the air and the APK does not. */
export function pickLockPath(plugin: { authenticate?: unknown; wrap?: unknown } | null | undefined): LockPath | null {
  if (typeof plugin?.authenticate === "function") return "authenticate";
  if (typeof plugin?.wrap === "function") return "sentinel";
  return null;
}

export function lockOnStart(prefOn: boolean, path: LockPath | null): boolean {
  return prefOn && path !== null;
}

export function shouldLockOnWake(hiddenAt: number | null, now: number): boolean {
  return hiddenAt !== null && now - hiddenAt > APP_LOCK_GRACE_MS;
}

/**
 * The status read taken right after a refusal, tagged by which call made it,
 * because the two do not mean the same thing. `lockStatus()` is the newer
 * shell's. `status()` is all an old APK has, and it reads a transient
 * HW_UNAVAILABLE as `hardware: false`.
 */
export type LockReread =
  | { source: "lockStatus"; hardware: boolean; enrolled: boolean; screenLock: boolean }
  | { source: "status"; hardware: boolean; enrolled: boolean };

/** The two refusals that mean nothing until a fresh read agrees with them. */
export function needsReread(code: string): boolean {
  return code === "noHardware" || code === "noneEnrolled";
}

/**
 * Does the read confirm this refusal? `enrolled: false` alone never does: a down
 * sensor or a lockout reads false too. On `status()` a false `hardware` proves
 * nothing, so `noHardware` cannot be confirmed there at all.
 */
function confirms(code: string, r: LockReread | null | undefined): boolean {
  if (!r) return false;
  if (r.source === "lockStatus") return r.hardware === false || (r.enrolled === false && r.screenLock === false);
  return code === "noneEnrolled" && r.hardware === true && r.enrolled === false;
}

export type LockVerdict = "stay" | "open-and-off";

/**
 * What a refusal does. `reread` is the fresh status read for `needsReread`
 * codes; `null` means it threw. Only the cases named here open.
 */
export function lockVerdict(code: string, reread?: LockReread | null): LockVerdict {
  if (code === "keyInvalidated" || code === "noKey" || code === "badInput") return "open-and-off";
  if (needsReread(code) && confirms(code, reread)) return "open-and-off";
  return "stay";
}

/** The shell's own words, closed as a sentence so the next one can follow. */
function shellSentence(code: string, message: string | undefined): string {
  const m = (message ?? "").trim();
  if (!m || m === code) return "The fingerprint sheet could not be shown.";
  return /[.!?]$/.test(m) ? m : `${m}.`;
}

/** The sentence for a refusal. `message` is the shell's, kept for `failed`. */
export function lockWords(code: string, path: LockPath | null, verdict: LockVerdict, message?: string, savedPlain = false): string {
  if (verdict === "open-and-off") {
    switch (code) {
      case "keyInvalidated":
      case "noKey":
        return `A fingerprint was added or removed on this phone, so the app lock was reset. ${APP_LOCK_WAY_BACK}`;
      case "badInput":
        return `The app lock's saved check could not be read, so the app lock was reset. ${APP_LOCK_WAY_BACK}`;
      default:
        return `This phone has no usable fingerprint right now, so the app lock was switched off. ${APP_LOCK_WAY_BACK}`;
    }
  }
  switch (code) {
    case "cancelled":
      return "The prompt was dismissed. Tap unlock to try again.";
    case "lockout":
      return "Too many tries — the phone has paused fingerprints for now. Unlock the phone with its PIN, then tap unlock.";
    case "busy":
      return "Another fingerprint prompt is already up — finish that one first.";
    case "plainRoute":
      return savedPlain
        ? "The fingerprint is off because this desktop is saved at an unprotected address, on any network. Update the Android app, or clear this app's data."
        : "The fingerprint is off while the route to the desktop is not protected. Leave this Wi-Fi so the app goes over the tailnet, then tap unlock.";
    case "noHardware":
      return path === "authenticate"
        ? "The fingerprint sensor is not available right now. Tap unlock to use the phone's PIN."
        : "The fingerprint sensor is not available right now. Tap unlock to try again.";
    case "noneEnrolled":
      return path === "authenticate"
        ? "No fingerprint is enrolled on this phone right now. Tap unlock to use the phone's PIN."
        : "No fingerprint is enrolled on this phone right now. Add one in Android settings, then tap unlock.";
    default:
      return `${shellSentence(code, message)} Tap unlock to try again.`;
  }
}

/** The lock card's one line. */
export function lockBody(path: LockPath | null): string {
  return path === "authenticate"
    ? `Unlock with your fingerprint or the phone's PIN to use ${BRAND.name}.`
    : `Unlock with your fingerprint to use ${BRAND.name}.`;
}

/** The row's note. A newer shell's sheet also takes the phone's PIN. */
export function lockRowNote(path: LockPath | null): string {
  const base = "Asks for your fingerprint when the app opens, and when you come back after a minute away.";
  return path === "authenticate" ? `${base} The phone's PIN works too.` : base;
}

export const LOCK_ROW_MORE = "Only this phone. The desktop, its password and the paired-device tokens are untouched; queued sends and notifications keep working behind the lock. A fingerprint added or removed on the phone resets the lock — it says so, and this switch turns it back on.";

/**
 * Why the switch cannot be turned on, as a sentence, or null when it can. Only
 * asked while the lock is off: a lock that is on always shows its switch.
 * `read` is the fresh status, null until it arrives or when it threw (then the
 * sheet itself will say what is wrong).
 */
export function lockRowCant(path: LockPath | null, plain: boolean, read: LockReread | null, savedPlain = false): string | null {
  if (path === null) return "needs a newer Android app — this one has no fingerprint keystore";
  if (path === "sentinel" && savedPlain) {
    return "needs the tailnet — this app's fingerprint is off at this desktop's saved address, which is not protected on any network. Save its tailnet address, or update the Android app";
  }
  if (path === "sentinel" && plain) {
    return "needs the tailnet — this app's fingerprint is off while the route to the desktop is not protected. Leave this Wi-Fi so the app goes over the tailnet, or update the Android app";
  }
  if (!read) return null;
  if (read.source === "lockStatus") {
    return read.enrolled === false && read.screenLock === false ? "set a screen lock on the phone first" : null;
  }
  if (read.hardware === false) return "this phone has no fingerprint sensor the app can use";
  if (read.enrolled === false) return "add a fingerprint in Android settings first";
  return null;
}

/** What the row says under it when the sheet refused. `on` is the direction asked for. */
export function lockRowRefusal(code: string, on: boolean, message?: string, savedPlain = false): string {
  const head = on ? "not turned on" : "not turned off";
  switch (code) {
    case "cancelled":
      return `${head} — the prompt was dismissed`;
    case "lockout":
      return `${head} — the phone has paused fingerprints for now; unlock it with its PIN and try again`;
    case "busy":
      return `${head} — another fingerprint prompt is already up`;
    case "plainRoute":
      if (savedPlain) return `${head} — the fingerprint is off because this desktop is saved at an unprotected address; save its tailnet address, update the Android app, or clear this app's data`;
      return `${head} — the fingerprint is off while the route to the desktop is not protected; leave this Wi-Fi so the app goes over the tailnet`;
    case "noHardware":
    case "noneEnrolled":
      return `${head} — no usable fingerprint on this phone right now`;
    default: {
      const m = (message ?? "").trim().replace(/[.!?]$/, "");
      return m && m !== code ? `${head} — ${m}` : `${head} — the fingerprint sheet could not be shown`;
    }
  }
}
