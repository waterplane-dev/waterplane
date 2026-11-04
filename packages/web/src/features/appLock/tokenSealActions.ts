/**
 * The sealed sign-ins on the phone: the cold-start gate and the flows the Settings row calls. What
 * each answer means is `logic.ts`'s (node-tested) and the write order `tokenVault.ts`'s.
 *
 * **One prompt.** With the sign-ins sealed the unseal's sheet IS the app lock's start prompt, so a
 * person who passed it has passed both. The lock's own sheet runs at a cold start only where the
 * unseal's never appeared.
 *
 * **Nothing dials first.** `main.tsx` draws the card alone while `sealGate.waiting`; `App` opens
 * the socket on its first render, so it mounts after this settles, and the queue flushes on the
 * first `onopen` as ever.
 */
import { lockOnStart, UNLOCK_PROMPT } from "../../appLock";
import { DEVICE_TOKEN_EVENT, heldTokens, holdTokens, sealedMode } from "../../deviceToken";
import { bootSettled } from "../../hostBoot";
import { browserKV, realHosts, listHosts } from "../../hosts";
import { nativeKeystore } from "../../nativeKeystore";
import { isDemo, setPref } from "../../sdk";
import { showToast } from "../../toast";
import { SEAL_FORGET_MOOT, sealKeyKind } from "../../tokenSealWords";
import { sealedHostIds } from "../../tokenVault";
import { appLockAdapter, appLockOn, lockRefused, prompted, savedPlain } from "./lockActions";
import {
  cardActions, FORGET_PROMPT, lockMayStillAsk, NEEDS_KEYSTORE, OPEN_PROMPT, openBlob, rewrapNow, retireSeal, sealBody, sealLostWords, sealNow, sealRefusalWords,
  sealUnreadableWords, SEAL_EXIT_TOAST, SEAL_GATE_OPEN, SEAL_NO_BLOB, SEAL_NO_KEYSTORE, shownStuck, startGate, unsealNow, type SealPorts, type SwitchResult,
} from "./logic";
import { locked, sealGate } from "./store";

function ports(): SealPorts | null {
  const kv = browserKV();
  if (!kv || !appLockAdapter.path()) return null;
  return {
    kv,
    generate: (o) => nativeKeystore.generate(o),
    wrap: (o) => prompted(() => nativeKeystore.wrap(o)),
    unwrap: (o) => prompted(() => nativeKeystore.unwrap(o)),
    reread: () => appLockAdapter.reread(),
    savedPlain,
  };
}

/** Is the app lock on, and able to ask? */
const lockOwed = (): boolean => lockOnStart(appLockOn(), appLockAdapter.path());

/** The saved desktops the blob lists, as the phone names them. */
function sealedNames(): string[] {
  const kv = browserKV();
  if (!kv) return [];
  const ids = new Set(sealedHostIds(kv));
  return realHosts(listHosts()).filter((h) => ids.has(h.id)).map((h) => h.name || h.base.replace(/^https?:\/\//, ""));
}

/** The token event, for the background link: `releaseTokens` has none of its own. */
function tokensMoved(): void {
  window.dispatchEvent(new Event(DEVICE_TOKEN_EVENT));
}

/** A sentence for the row to keep: the last time the sign-ins were lost this run, until read. */
let lostNote: string | null = null;
export const sealLostNote = (): string | null => lostNote;
export const clearSealLostNote = (): void => { lostNote = null; };

/** A refusal this run showed the seal cannot be opened. Memory only: the next start must show it again. */
let stuck = false;

/** Does the row offer *forget*? Sign-ins opened this run prove the seal opens, whatever said no since. */
export const sealCannotOpen = (): boolean => stuck && sealedMode() && heldTokens() === null;

/** Before the first render, with `armAppLock`. A browser and the demo never get here sealed. */
export function armTokenSeal(): void {
  const kv = browserKV();
  if (kv && !isDemo()) sealGate.set(startGate(kv, appLockAdapter.path()));
}

let toldBoot = false;

/** What the boot found and nobody has said yet. Once, when the toast layer exists. */
export function saySealBoot(): void {
  if (toldBoot || isDemo()) return;
  toldBoot = true;
  if (bootSettled() === "repair-no-blob") showToast(SEAL_NO_BLOB);
  else if (sealedMode() && !appLockAdapter.path()) showToast(SEAL_NO_KEYSTORE);
}

/** The gate is over. `owed`: the lock still has its own check to make, over the mounted app. */
function land(owed: boolean): void {
  sealGate.set(SEAL_GATE_OPEN);
  locked.set(owed);
}

/** The lock's own sheet. Null when it passed or the lock went off, else why not. */
async function lockSheet(text: typeof UNLOCK_PROMPT): Promise<string | null> {
  try {
    await appLockAdapter.confirm(text);
    return null;
  } catch (e) {
    const r = await lockRefused(e);
    return r.off ? null : r.words;
  }
}

/** The lock's own sheet at a cold start: what `cardActions` waits for. */
async function lockCheck(): Promise<string | null> {
  const why = await lockSheet(UNLOCK_PROMPT);
  if (!why) sealGate.set({ ...sealGate.get(), lockPassed: true });
  return why;
}

/** One attempt from the cold-start card. Null when there is nothing to say. */
export async function tryUnseal(): Promise<string | null> {
  const g = sealGate.get();
  const p = ports();
  if (!p) { land(lockOwed()); return null; }
  if (g.unreadable) {
    stuck = true;
    return cardActions(g, lockOwed()).unlock ? lockCheck() : null;
  }
  const r = await openBlob(p, UNLOCK_PROMPT);
  stuck ||= shownStuck(r);
  if (r.ok) {
    holdTokens(r.tokens);
    land(false);
    return null;
  }
  if (r.why === "unreadable") {
    sealGate.set({ ...g, unreadable: true, lockPassed: g.lockPassed || r.passed });
    return null; // the card's body says it
  }
  if (r.verdict === "open-and-off") {
    const words = sealLostWords(r.code, sealedNames());
    retireSeal(p.kv);
    setPref("tokenSeal", false);
    lostNote = words;
    showToast(words);
    land(lockOwed()); // never through the lock: its card comes up over the app and asks for itself
    return null;
  }
  if (lockMayStillAsk(r.code, appLockAdapter.path()) && lockOwed() && !g.lockPassed) {
    const stuck = await lockCheck();
    if (stuck) return stuck;
  }
  return sealRefusalWords(r.code, r.message, cardActions(sealGate.get(), lockOwed()).exit, savedPlain());
}

/** The card's other button. Checks again here: the lock is passed or off, or nothing happens. */
export function openWithoutTokens(): void {
  const g = sealGate.get();
  if (!g.waiting || !cardActions(g, lockOwed()).exit) return;
  land(false);
  showToast(SEAL_EXIT_TOAST);
}

/** The card's line for the key this seal is under. */
export function sealCardBody(): string {
  const kv = browserKV();
  return sealBody(kv ? sealKeyKind(kv) : null);
}

/** What the card's body says about the bytes, if it must. */
export function sealCardNote(): string | null {
  const g = sealGate.get();
  return g.waiting && g.unreadable ? sealUnreadableWords(cardActions(g, lockOwed()).exit) : null;
}

const noKeystore: SwitchResult = { ok: false, why: "noKeystore", words: NEEDS_KEYSTORE };

/** Settings: lock the sign-ins. One sheet. The row words the result. */
export async function sealTokens(): Promise<SwitchResult> {
  const p = ports();
  if (!p) return noKeystore;
  const r = await sealNow(p);
  if (r.ok) { setPref("tokenSeal", true); clearSealLostNote(); }
  return r;
}

/** Settings: store the sign-ins on the phone again. One sheet. */
export async function unsealTokens(): Promise<SwitchResult> {
  const p = ports();
  if (!p) return noKeystore;
  const r = await unsealNow(p, sealedNames());
  stuck ||= shownStuck(r);
  if (r.ok || r.why === "lost") { setPref("tokenSeal", false); tokensMoved(); }
  if (!r.ok && r.why === "lost") lostNote = r.words;
  return r;
}

/**
 * Open the sign-ins in a running app, after "open without the sign-ins" (the gate card on a
 * desktop that asked, or the row). One sheet. Null when they are in memory; the caller reconnects.
 */
export async function unlockSignIns(): Promise<string | null> {
  const p = ports();
  if (!p) return SEAL_NO_KEYSTORE;
  const r = await openBlob(p, OPEN_PROMPT);
  stuck ||= shownStuck(r);
  if (r.ok) { holdTokens(r.tokens); return null; }
  if (r.why === "unreadable") return sealUnreadableWords(false);
  if (r.verdict === "stay") return sealRefusalWords(r.code, r.message, false, savedPlain());
  const words = sealLostWords(r.code, sealedNames());
  retireSeal(p.kv);
  setPref("tokenSeal", false);
  lostNote = words;
  tokensMoved();
  return words;
}

/**
 * Settings: *forget the locked sign-ins*, after the row's confirm. `words` stays on the row.
 * Checks again here: only with a refusal behind it, and past the lock's own sheet when the lock is
 * on, though the app is open behind it: this is the one way off with no sheet of the seal's own.
 * Null when it is done, else why not. It never writes a token to storage, held ones included.
 */
export async function forgetSignIns(words: string): Promise<string | null> {
  const kv = browserKV();
  if (!kv || !sealCannotOpen()) return SEAL_FORGET_MOOT;
  if (lockOwed()) {
    const why = await lockSheet(FORGET_PROMPT);
    if (why) return why;
  }
  retireSeal(kv);
  setPref("tokenSeal", false);
  lostNote = words;
  tokensMoved();
  return null;
}

/** A pairing landed in memory: seal it. Null when it did, else the sentence to show. */
export async function rewrapAfterPair(name: string): Promise<string | null> {
  const p = ports();
  return p ? rewrapNow(p, name) : `${name} is paired, held in memory until the app restarts. ${SEAL_NO_KEYSTORE}`;
}
