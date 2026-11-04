/**
 * The sealed sign-ins' flows and the cold-start gate's decisions: what one attempt does with what
 * the Keystore answered, and what the card may offer. Node-tested over fake ports, so the rules
 * below are not left to a device. `tokenVault.ts` holds the write order; `tokenSealActions.ts` wires this
 * to the phone.
 *
 * **Fail-closed, by the seal's own rule** (`sealVerdict`): only a confirmed reason turns the seal
 * off, and any other code, heard of or not, stays. It is not the lock's rule: the lock has nothing
 * to lose and asks a sensor, the seal holds the only copy under a key that outlives the sensor.
 * And a verdict can be wrong, so `retireSeal` sets the blob aside rather than deleting it.
 *
 * **"Open without the sign-ins" never passes the app lock.** `cardActions` offers it only with the
 * lock off or after the lock's own check passed. It leaves the blob and the flag as they are.
 */
import { BRAND } from "@waterplane/shared";
import { lockRowRefusal, lockWords, needsReread, type LockPath, type LockReread, type LockVerdict } from "../../appLock.ts";
import { heldTokens, holdTokens, releaseTokens } from "../../deviceToken.ts";
import type { KV } from "../../hosts.ts";
import { LS } from "../../storage.ts";
import {
  collectTokens, commitRewrap, commitSeal, commitUnseal, parseSealBlob, readSealPlaintext, sealPlaintext,
  TOKEN_AAD, TOKEN_ALIAS, type TokenMap,
} from "../../tokenVault.ts";
import { askedFor, SEAL_PAIR_HOW, SEAL_WAY_BACK, type SealKeyKind } from "../../tokenSealWords.ts";

type Text = { title: string; subtitle?: string };

/** The phone, as the flows use it. A rejection carries a `code`; a sheet is at most one call. */
export interface SealPorts {
  kv: KV;
  generate(o: { alias: string; replace: true; auth: "any" }): Promise<{ auth?: "biometric" | "any" }>;
  wrap(o: { alias: string; dataB64: string; aadB64: string } & Text): Promise<{ ctB64: string; nonceB64: string }>;
  unwrap(o: { alias: string; ctB64: string; nonceB64: string; aadB64: string } & Text): Promise<{ dataB64: string }>;
  /** Is the active desktop's SAVED address unprotected? Then leaving a Wi-Fi changes nothing. */
  savedPlain(): boolean;
  /** The fresh status read `sealVerdict` wants; null when it threw. */
  reread(): Promise<LockReread | null>;
}

const AAD_B64 = btoa(TOKEN_AAD);

export const SEAL_PROMPT: Text = { title: "Lock the desktop sign-ins", subtitle: "Confirm it's you to lock them on this phone" };
export const UNSEAL_PROMPT: Text = { title: "Unlock the desktop sign-ins", subtitle: "Confirm it's you to store them on this phone again" };
export const OPEN_PROMPT: Text = { title: "Unlock the desktop sign-ins" };
export const FORGET_PROMPT: Text = { title: "Forget the locked sign-ins", subtitle: "Confirm it's you" };
export const rewrapPrompt = (name: string): Text => ({ title: "Lock the desktop sign-ins", subtitle: `Seal the sign-in for ${name}` });

export const SEAL_EXIT_NOTE = "Password-protected desktops stay locked until you unlock here or in Settings › Connection › lock the desktop sign-ins.";
export const SEAL_EXIT_TOAST = "Opened without the sign-ins. They stay locked: a desktop that needs one asks for it.";
export const SEAL_NO_KEYSTORE = "This app has no fingerprint keystore, so the desktop sign-ins stay locked. A desktop with a password shows as signed out.";
export const SEAL_NO_BLOB = `The desktop sign-ins were locked but their saved copy is gone, so that lock is off. If a desktop shows as signed out, pair it again. ${SEAL_WAY_BACK}`;
const UNREADABLE = "This version of the app cannot read the saved desktop sign-ins, perhaps because a newer one wrote them. They are kept on this phone.";
export const NEEDS_KEYSTORE = "needs a newer Android app — this one has no fingerprint keystore";

/** The sentence on the card when the bytes cannot be read. `exit`: the way past is on the card. */
export function sealUnreadableWords(exit: boolean): string {
  return exit ? `${UNREADABLE} Update the app, or open without the sign-ins.` : `${UNREADABLE} Update the app, or unlock to open without them.`;
}

/** The card's one line, by the key: this is that key's sheet, whatever the lock's own path offers. */
export function sealBody(kind: SealKeyKind): string {
  return `Unlock with ${askedFor(kind)} to open ${BRAND.name} and its desktop sign-ins.`;
}

/**
 * A refusal the card stays on. Worded as the sentinel path whatever the lock's path is: the seal's
 * key is a key, so "tap unlock to use the phone's PIN" about a missing fingerprint would not hold.
 */
export function sealRefusalWords(code: string, message: string | undefined, exit: boolean, savedPlain = false): string {
  if (code === "plainRoute") {
    if (savedPlain) return `The fingerprint key is refused because this desktop is saved at an unprotected address, on any network. Update the Android app, or clear this app's data${exit ? " — or open without the sign-ins" : ""}.`;
    return `The fingerprint key is refused while the route to the desktop is not protected. Leave this Wi-Fi so the app goes over the tailnet, then tap unlock${exit ? " — or open without the sign-ins" : ""}.`;
  }
  return lockWords(code, "sentinel", "stay", message);
}

/** Said once the sign-ins are gone for good. Which change it was is not known for an `any` key. */
export function sealLostWords(code: string, names: readonly string[]): string {
  const head = code === "badInput"
    ? "The saved desktop sign-ins could not be opened, so they were dropped."
    : code === "keyInvalidated" || code === "noKey"
      ? "The fingerprints or the screen lock on this phone changed, so the desktop sign-ins were lost."
      : "This phone has no usable fingerprint or screen lock right now, so the desktop sign-ins were lost.";
  const who = names.length ? `${names.join(", ")}: if` : "If";
  return `${head} A desktop with a LAN password signs this phone in again by itself. ${who} one shows as signed out, pair it again (${SEAL_PAIR_HOW}). ${SEAL_WAY_BACK}`;
}

/** A pairing whose token could not join the blob. The reload that follows would lose it. */
export function pairHeldWords(name: string, tail: string): string {
  return `${name} is paired, held in memory until the app restarts; the seal was not updated (${tail}). Pair again after the next start, or turn the sign-in lock off in Settings › Connection; if that refuses too, forget the locked sign-ins is there.`;
}

// ── The gate ─────────────────────────────────────────────────────────────

export interface SealGate {
  /** `App` is not mounted, so nothing has dialled. */
  waiting: boolean;
  /** The app lock's own check passed this cold start, by a route other than the unseal. */
  lockPassed: boolean;
  /** The bytes cannot be opened by this build, so unlock can only ever be the lock's check. */
  unreadable: boolean;
}

export const SEAL_GATE_OPEN: SealGate = { waiting: false, lockPassed: false, unreadable: false };

/** Where a cold start begins. No way to ask means no card: the app opens with the blob untouched. */
export function startGate(kv: KV, path: LockPath | null): SealGate {
  if (kv.getItem(LS.tokenSealOn) !== "1" || path === null) return SEAL_GATE_OPEN;
  return { waiting: true, lockPassed: false, unreadable: parseSealBlob(kv.getItem(LS.tokenSeal)) === null };
}

/** What the card offers. `lockOn`: the app lock is on and can ask. */
export function cardActions(g: SealGate, lockOn: boolean): { unlock: boolean; exit: boolean } {
  const exit = !lockOn || g.lockPassed;
  return { unlock: !(g.unreadable && exit), exit };
}

/**
 * Refusals where the lock may still ask by itself: a PIN passes `authenticate` with no key, and that
 * is the check `cardActions` waits for. Either the unseal's sheet never appeared, or it took no PIN
 * (a key from an older shell), which on `authenticate` the lock's own sheet still does.
 */
export function lockMayStillAsk(code: string, path: LockPath | null): boolean {
  return code === "plainRoute" || needsReread(code) || (path === "authenticate" && (code === "lockout" || code === "failed"));
}

/**
 * What a refusal does to the seal. `noHardware` never retires it, confirmed or not: an `any` key
 * lives on the screen lock, and a PIN-only phone reads `hardware: false` for ever. `enrolled: false`
 * counts only with no screen lock left, or on `status()` with a sensor that is there: fingerprints
 * all removed, which is a biometric key's end. Only the cases named here turn it off.
 */
export function sealVerdict(code: string, reread?: LockReread | null): LockVerdict {
  if (code === "keyInvalidated" || code === "noKey" || code === "badInput") return "open-and-off";
  if (code !== "noneEnrolled" || !reread) return "stay";
  const gone = reread.source === "lockStatus" ? !reread.enrolled && !reread.screenLock : reread.hardware && !reread.enrolled;
  return gone ? "open-and-off" : "stay";
}

/** Refusals about the moment, not the seal: the person, another sheet, a lockout, this Wi-Fi. */
const PASSING_REFUSALS: readonly string[] = ["cancelled", "busy", "lockout", "plainRoute"];

/** Did this attempt show the seal cannot be opened here? It is what puts *forget* on the row. */
export function shownStuck(r: { ok: boolean; why?: string; code?: string }): boolean {
  if (r.ok) return false;
  return r.why === "unreadable" || (r.why === "refused" && !PASSING_REFUSALS.includes(r.code ?? ""));
}

// ── The flows ────────────────────────────────────────────────────────────

interface Refused { why: "refused"; code: string; message: string; verdict: LockVerdict }

async function refused(p: SealPorts, e: unknown): Promise<Refused> {
  const o = (e ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof o.code === "string" ? o.code : "failed";
  const reread = needsReread(code) ? await p.reread() : null;
  return { why: "refused", code, message: typeof o.message === "string" ? o.message : "", verdict: sealVerdict(code, reread) };
}

export type OpenResult =
  | { ok: true; tokens: TokenMap }
  /** `passed`: the sheet was, so the person is here, and what came out was not a token map. */
  | { ok: false; why: "unreadable"; passed: boolean }
  | ({ ok: false } & Refused);

/** One sheet: what the blob holds. Changes nothing. */
export async function openBlob(p: SealPorts, text: Text): Promise<OpenResult> {
  const blob = parseSealBlob(p.kv.getItem(LS.tokenSeal));
  if (!blob) return { ok: false, why: "unreadable", passed: false };
  let dataB64: string;
  try {
    ({ dataB64 } = await p.unwrap({ alias: TOKEN_ALIAS, ctB64: blob.ct, nonceB64: blob.nonce, aadB64: AAD_B64, ...text }));
  } catch (e) {
    return { ok: false, ...(await refused(p, e)) };
  }
  let tokens: TokenMap | null = null;
  try { tokens = readSealPlaintext(atob(dataB64)); } catch { /* not base64: not ours */ }
  return tokens ? { ok: true, tokens } : { ok: false, why: "unreadable", passed: true };
}

/** The blob, copied to `tokenSealDead`. False when the copy did not land: it is then the last one. */
function setBlobAside(kv: KV): boolean {
  const raw = kv.getItem(LS.tokenSeal);
  if (raw === null) return true;
  try {
    kv.setItem(LS.tokenSealDead, raw);
    return kv.getItem(LS.tokenSealDead) === raw;
  } catch {
    return false;
  }
}

/**
 * The seal is dead: blob first, because a flag left behind clears itself at boot and a blob left
 * behind puts the mode back on. It moves rather than goes, so a wrong verdict destroys nothing; a
 * move storage refused leaves it in place, and the next boot's `settleAtBoot` turns the mode back
 * on. Nothing is asked of the Keystore: the next `generate` replaces the key.
 */
export function retireSeal(kv: KV): void {
  if (setBlobAside(kv)) kv.removeItem(LS.tokenSeal);
  kv.removeItem(LS.tokenSealOn);
  releaseTokens();
}

export type SwitchRefusal =
  | "noKeystore" // this shell cannot ask
  | "nothing" // no token on this phone to lock
  | "changed" // a token landed while the sheet was up, or the mode moved: nothing happened
  | "storage" // the phone's storage refused: nothing happened
  | "unreadable" // this build cannot read the blob: nothing happened
  | "refused" // the sheet or the key said no: `code`
  | "lost"; // the key is gone for good: the mode is off, the sign-ins are gone
/** `words` is the row's whole sentence. `auth` says what opens the key: `biometric` from an older shell. */
export type SwitchResult =
  | { ok: true; auth?: "biometric" | "any" }
  | { ok: false; why: SwitchRefusal; code?: string; words: string };

const STORAGE_WORDS = (on: boolean) => `${on ? "not turned on" : "not turned off"} — this phone's storage refused it; nothing changed`;
const CHANGED_WORDS = (on: boolean) => `${on ? "not turned on" : "not turned off"} — the sign-ins changed while the sheet was up; try again`;

/** Turn sealing on: one sheet. Reads the tokens before it and commits after, in that order. */
export async function sealNow(p: SealPorts): Promise<SwitchResult> {
  if (p.kv.getItem(LS.tokenSealOn) === "1") return { ok: false, why: "changed", words: CHANGED_WORDS(true) };
  const tokens = collectTokens(p.kv);
  if (Object.keys(tokens).length === 0) {
    return { ok: false, why: "nothing", words: "nothing to lock: none of your desktops has a password, so this phone holds no sign-in" };
  }
  let wrapped: { ct: string; nonce: string };
  let auth: "biometric" | "any";
  try {
    auth = (await p.generate({ alias: TOKEN_ALIAS, replace: true, auth: "any" })).auth ?? "biometric";
    const w = await p.wrap({ alias: TOKEN_ALIAS, dataB64: btoa(sealPlaintext(tokens)), aadB64: AAD_B64, ...SEAL_PROMPT });
    wrapped = { ct: w.ctB64, nonce: w.nonceB64 };
  } catch (e) {
    const r = await refused(p, e);
    return { ok: false, why: "refused", code: r.code, words: lockRowRefusal(r.code, true, r.message, p.savedPlain()) };
  }
  // Before the flag, and kept after the mode goes off: the key stays, so this stays true of it.
  try { p.kv.setItem(LS.tokenSealAuth, auth); } catch { p.kv.removeItem(LS.tokenSealAuth); }
  const c = commitSeal(p.kv, wrapped, tokens);
  if (!c.ok) return { ok: false, why: c.why === "changed" ? "changed" : "storage", words: c.why === "changed" ? CHANGED_WORDS(true) : STORAGE_WORDS(true) };
  holdTokens(tokens);
  return { ok: true, auth };
}

/**
 * Turn sealing off: one sheet. What arrived this run goes back too, so the blob alone is not the
 * list. A key gone for good loses nothing still held in memory; only what was not is said lost.
 */
export async function unsealNow(p: SealPorts, names: readonly string[]): Promise<SwitchResult> {
  if (p.kv.getItem(LS.tokenSealOn) !== "1") return { ok: false, why: "changed", words: CHANGED_WORDS(false) };
  const r = await openBlob(p, UNSEAL_PROMPT);
  if (!r.ok) {
    if (r.why === "unreadable") return { ok: false, why: "unreadable", words: `not turned off — ${UNREADABLE} Update the app, then try again` };
    if (r.verdict === "stay") return { ok: false, why: "refused", code: r.code, words: lockRowRefusal(r.code, false, r.message, p.savedPlain()) };
    const held = heldTokens();
    if (held && commitUnseal(p.kv, held).ok) { releaseTokens(); return { ok: true }; }
    retireSeal(p.kv);
    return { ok: false, why: "lost", code: r.code, words: sealLostWords(r.code, names) };
  }
  holdTokens(r.tokens);
  const c = commitUnseal(p.kv, heldTokens() ?? r.tokens);
  if (!c.ok) return { ok: false, why: c.why === "changed" ? "changed" : "storage", words: c.why === "changed" ? CHANGED_WORDS(false) : STORAGE_WORDS(false) };
  releaseTokens();
  return { ok: true };
}

const tailOf = (code: string, message?: string): string => {
  if (code === "cancelled") return "the prompt was dismissed";
  const m = (message ?? "").trim().replace(/[.!?]$/, "");
  return m && m !== code ? m : code;
};

/**
 * A token arrived while sealed: put it in the blob, with the existing key. Null when it landed,
 * else the sentence. The blob is only ever replaced by a COMPLETE map: if it was not opened this
 * run (`heldTokens()` null) it is opened first, a second sheet, because a single-use pair code is
 * worth one. Refused, the blob stays exactly as it was and every other desktop with it.
 */
export async function rewrapNow(p: SealPorts, name: string): Promise<string | null> {
  if (!heldTokens()) {
    const r = await openBlob(p, OPEN_PROMPT);
    if (!r.ok) return pairHeldWords(name, r.why === "unreadable" ? "this version of the app cannot read the saved sign-ins" : tailOf(r.code, r.message));
    holdTokens(r.tokens);
  }
  const tokens = heldTokens();
  if (!tokens) return pairHeldWords(name, "the saved sign-ins were not opened");
  try {
    const w = await p.wrap({ alias: TOKEN_ALIAS, dataB64: btoa(sealPlaintext(tokens)), aadB64: AAD_B64, ...rewrapPrompt(name) });
    const c = commitRewrap(p.kv, { ct: w.ctB64, nonce: w.nonceB64 }, tokens);
    return c.ok ? null : pairHeldWords(name, "this phone's storage refused it");
  } catch (e) {
    const o = (e ?? {}) as { code?: unknown; message?: unknown };
    return pairHeldWords(name, tailOf(typeof o.code === "string" ? o.code : "failed", typeof o.message === "string" ? o.message : ""));
  }
}
