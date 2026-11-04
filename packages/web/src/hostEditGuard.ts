/**
 * The one address the editor must not save: a plain-HTTP base while the sign-ins are sealed and
 * the app lock is on through the sentinel key (an old APK). Both keys are refused over plain HTTP
 * and a cold start dials the SAVED base, so nothing could ever open the app again short of
 * clearing its data. Pure: the caller passes what the phone says.
 */
import { isPlainRoute } from "@waterplane/shared";

export const PLAIN_SAVE_TRAP_WORDS =
  "Not saved: with the sign-in lock and the app lock both on, this Android app cannot open at a plain-HTTP address. Save its tailnet address, or turn the sign-in lock off first.";

export function plainSaveRefusal(base: string, sealed: boolean, lockOn: boolean, lockPath: string | null): string | null {
  return sealed && lockOn && lockPath === "sentinel" && isPlainRoute(base) ? PLAIN_SAVE_TRAP_WORDS : null;
}
