/**
 * The two ways this shell asks, and the away clock around a sheet. Under both `tokenSealActions.ts` and
 * `actions.ts`, which each run a sheet.
 */
import { lockVerdict, lockWords, needsReread, pickLockPath, APP_LOCK_ALIAS, type LockPath, type LockReread } from "../../appLock";
import { activeHost } from "../../hosts";
import { isKeystoreError, nativeKeystore, toKeystoreError, type KeystoreError, type PromptText } from "../../nativeKeystore";
import { isDemo, setPref } from "../../sdk";
import { nativePlugin } from "../../shellBridge";
import { LS, lsBool, lsDel, lsJson, lsSetJson } from "../../storage";
import { showToast } from "../../toast";
import { rowSavedPlain } from "../../tokenSealWords";
import { locked } from "./store";

/** Is the active desktop saved at an unprotected address? The saved row, never the live route. */
export const savedPlain = (): boolean => rowSavedPlain(activeHost());

/** The switch, read straight from the phone. For a component: `usePref("appLock")`. */
export const appLockOn = (): boolean => lsBool(LS.appLock);

const AAD_B64 = btoa("applock");

function randomB64(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}

function readBlob(): { ct: string; nonce: string } {
  const b = lsJson<{ ct?: unknown; nonce?: unknown } | null>(LS.appLockBlob, null);
  if (typeof b?.ct === "string" && typeof b.nonce === "string") return { ct: b.ct, nonce: b.nonce };
  throw { code: "badInput", message: "the app lock's saved check is missing" } satisfies KeystoreError;
}

/** When the app went out of sight. Memory only: a killed process cold-starts, which locks anyway. */
let hiddenAt: number | null = null;
let prompts = 0;

/** The out-of-sight edge. The earliest one counts; a locked app, or one behind its own sheet, has nothing to time. */
export function noteHidden(): void {
  if (hiddenAt === null && prompts === 0 && !locked.get()) hiddenAt = Date.now();
}

/** Is one of our sheets up? */
export const promptUp = (): boolean => prompts > 0;

/** Spend the away clock: when the app went out of sight, if it did. */
export function takeHiddenAt(): number | null {
  const at = hiddenAt;
  hiddenAt = null;
  return at;
}

/**
 * Run one system sheet. Below API 30 the PIN screen is a separate activity, so
 * the page goes hidden during our own prompt: while one is up, visibility means
 * nothing and the away clock does not start. If the page is still hidden when
 * it settles the person left, and the clock starts then.
 */
export async function prompted<T>(ask: () => Promise<T>): Promise<T> {
  prompts++;
  try {
    return await ask();
  } finally {
    prompts--;
    if (document.visibilityState === "hidden") noteHidden();
  }
}

/** Everything the settings row needs from the phone. None of it writes the pref. */
export const appLockAdapter = {
  /** How this shell asks; null where there is no lock to offer (a browser, the demo, an old APK). */
  path(): LockPath | null {
    return isDemo() ? null : pickLockPath(nativePlugin("Keystore"));
  },
  /** One sheet that sets the lock up. Rejects a `KeystoreError`; the caller then keeps it off. */
  async enable(text: PromptText): Promise<void> {
    if (this.path() === "authenticate") {
      await prompted(() => nativeKeystore.authenticate({ ...text, allowCredential: true }));
      return;
    }
    await nativeKeystore.generate({ alias: APP_LOCK_ALIAS, replace: true });
    const b = await prompted(() => nativeKeystore.wrap({ alias: APP_LOCK_ALIAS, dataB64: randomB64(), aadB64: AAD_B64, ...text }));
    lsSetJson(LS.appLockBlob, { ct: b.ctB64, nonce: b.nonceB64 });
  },
  /** One sheet that proves the person is here: unlocking, and turning the lock off. */
  async confirm(text: PromptText): Promise<void> {
    if (this.path() === "authenticate") {
      await prompted(() => nativeKeystore.authenticate({ ...text, allowCredential: true }));
      return;
    }
    const b = readBlob();
    await prompted(() => nativeKeystore.unwrap({ alias: APP_LOCK_ALIAS, ctB64: b.ct, nonceB64: b.nonce, aadB64: AAD_B64, ...text }));
  },
  /** The status read `lockVerdict` wants. Null when it threw, which stays locked. */
  async reread(): Promise<LockReread | null> {
    try {
      if (this.path() === "authenticate") {
        return { source: "lockStatus", ...(await nativeKeystore.lockStatus()) };
      }
      return { source: "status", ...(await nativeKeystore.status()) };
    } catch {
      return null;
    }
  },
  /** Drop the key and blob once the lock is off. Best effort: nothing is secret, and turning it on makes new ones. */
  async forget(): Promise<void> {
    lsDel(LS.appLockBlob);
    try { await nativeKeystore.remove({ alias: APP_LOCK_ALIAS }); } catch { /* no key, or no keystore: nothing to drop */ }
  },
};

/**
 * What a refusal of the LOCK's own sheet does. `off`: the lock is off now, said in a toast, and
 * the caller decides what opens. Otherwise `words` is what the card shows.
 */
export async function lockRefused(e: unknown): Promise<{ off: boolean; words: string }> {
  const err = isKeystoreError(e) ? e : toKeystoreError(e);
  const reread = needsReread(err.code) ? await appLockAdapter.reread() : null;
  const verdict = lockVerdict(err.code, reread);
  const words = lockWords(err.code, appLockAdapter.path(), verdict, err.message, savedPlain());
  if (verdict === "stay") return { off: false, words };
  setPref("appLock", false);
  void appLockAdapter.forget();
  showToast(words);
  return { off: true, words };
}
