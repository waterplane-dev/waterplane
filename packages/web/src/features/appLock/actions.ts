/**
 * The app lock's moving parts: when the card goes up, and what one attempt does. The decisions are
 * `appLock.ts`'s, the asking `lockActions.ts`'s, and a cold start with the sign-ins sealed
 * `tokenSealActions.ts`'s.
 */
import { lockOnStart, shouldLockOnWake, NO_KEYSTORE_WORDS, UNLOCK_PROMPT } from "../../appLock";
import { isDemo } from "../../sdk";
import { holdToastsWhile, releaseToasts, showToast } from "../../toast";
import { appLockAdapter, appLockOn, lockRefused, noteHidden, promptUp, takeHiddenAt } from "./lockActions";
import { watchPage } from "./wakeActions";
import { locked, sealGate } from "./store";
import { armTokenSeal, saySealBoot, tryUnseal } from "./tokenSealActions";

export { appLockAdapter, appLockOn, noteHidden };
export { clearSealLostNote, openWithoutTokens, rewrapAfterPair, sealCardNote, sealLostNote, sealTokens, unlockSignIns, unsealTokens } from "./tokenSealActions";

/** Before the first render. Reads the switch once: the card must be up in the first frame. */
export function armAppLock(): void {
  watchPage(noteHidden, noteWake);
  // Boot sentences ("the lock is off … pair it again") are said under the card otherwise, and lost.
  holdToastsWhile(() => locked.get());
  locked.subscribe(releaseToasts);
  armTokenSeal();
  if (sealGate.get().waiting || lockOnStart(appLockOn(), appLockAdapter.path())) locked.set(true);
}

let toldNoKeystore = false;

/** The switch is on in a shell that cannot lock (a downgrade). Once, when the toast layer exists. */
export function sayIfCannotLock(): void {
  saySealBoot();
  if (toldNoKeystore || isDemo() || !appLockOn() || appLockAdapter.path()) return;
  toldNoKeystore = true;
  showToast(NO_KEYSTORE_WORDS);
}

/** Every wake event lands here, so repeats are harmless: the first one spends the away clock. */
export function noteWake(): void {
  if (document.visibilityState !== "visible" || promptUp()) return;
  const due = shouldLockOnWake(takeHiddenAt(), Date.now());
  if (due && lockOnStart(appLockOn(), appLockAdapter.path())) locked.set(true);
}

/** One attempt. Null when the card is gone; else the sentence it should show. */
export async function tryUnlock(): Promise<string | null> {
  if (sealGate.get().waiting) return tryUnseal();
  try {
    await appLockAdapter.confirm(UNLOCK_PROMPT);
    locked.set(false);
    return null;
  } catch (e) {
    const r = await lockRefused(e);
    if (!r.off) return r.words;
    locked.set(false);
    return null;
  }
}
