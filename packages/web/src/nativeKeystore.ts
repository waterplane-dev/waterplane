/**
 * A key on this phone that only a fingerprint can use — the page's half of
 * `ShellKeystorePlugin` (packages/app). Generic: it wraps and unwraps bytes and
 * knows nothing about what they are for.
 *
 * The key is AES-256-GCM inside the Android Keystore (StrongBox when there is
 * one), bound per use to a STRONG biometric and invalidated when a new
 * fingerprint is enrolled. Every `wrap` / `unwrap` shows the system's
 * fingerprint sheet; nothing here can use the key without one.
 *
 * Reached off the global Capacitor injects (`nativePlugin("Keystore")` ⇒
 * `Capacitor.Plugins.ShellKeystore`), like `nativeSave.ts`, so no native
 * dependency enters the bundle a browser downloads. In a plain browser, and in
 * an APK older than the plugin, `available()` is false and every call rejects
 * with `code: "unavailable"`.
 *
 * A refusal is a `KeystoreError` whose `code` is one word from
 * `KEYSTORE_CODES` — never a guess: anything the shell did not label is
 * `failed`, with the shell's message kept.
 */
import { nativePlugin } from "./shellBridge.ts";

/** The refusal words. All but `unavailable` come from the shell. */
export const KEYSTORE_CODES = [
  "unavailable", // no plugin: a browser, or an APK older than it
  "noHardware", // no usable strong biometric on this phone
  "noneEnrolled", // hardware, but no fingerprint enrolled
  "keyInvalidated", // a fingerprint was enrolled since the key was made; the key is gone for good
  "noKey", // no key under that alias
  "exists", // generate() without replace over an existing alias
  "cancelled", // the person (or the system) dismissed the sheet
  "lockout", // too many failed attempts; biometrics locked for now
  "busy", // another fingerprint sheet is already up
  "badInput", // missing alias, bad base64, or ciphertext/nonce/aad that does not authenticate
  "failed", // anything else
] as const;
export type KeystoreCode = (typeof KEYSTORE_CODES)[number];

export interface KeystoreError {
  code: KeystoreCode;
  message: string;
}

export interface KeystoreStatus {
  /** A strong biometric sensor exists and is usable. */
  hardware: boolean;
  /** …and at least one strong biometric is enrolled. */
  enrolled: boolean;
  /** The phone advertises a StrongBox keystore. */
  strongBox: boolean;
}

/** What a fingerprint sheet says. `title` defaults natively to "Confirm it's you". */
export interface PromptText {
  title?: string;
  subtitle?: string;
  /** Several lines under the subtitle; an app shell from before it was read ignores it. */
  description?: string;
}

type Plugin = {
  status(): Promise<KeystoreStatus>;
  has(o: { alias: string }): Promise<{ exists: boolean }>;
  generate(o: { alias: string; strongBox?: boolean; replace?: boolean }): Promise<{ strongBox: boolean }>;
  wrap(o: { alias: string; dataB64: string; aadB64?: string } & PromptText): Promise<{ ctB64: string; nonceB64: string }>;
  unwrap(o: { alias: string; ctB64: string; nonceB64: string; aadB64?: string } & PromptText): Promise<{ dataB64: string }>;
  remove(o: { alias: string }): Promise<void>;
};

function plugin(): Plugin | null {
  const p = nativePlugin<Plugin>("Keystore");
  return p && typeof p.wrap === "function" ? p : null;
}

/**
 * Any thrown value as a `KeystoreError`. Capacitor rejects with an Error
 * carrying the native `code`; a code this file does not know is `failed`
 * (never passed through), and the message survives either way.
 */
export function toKeystoreError(e: unknown): KeystoreError {
  const o = (e && typeof e === "object" ? e : {}) as { code?: unknown; message?: unknown; errorMessage?: unknown };
  const raw = typeof o.code === "string" ? o.code : "";
  const code = (KEYSTORE_CODES as readonly string[]).includes(raw) ? (raw as KeystoreCode) : "failed";
  const msg = typeof o.message === "string" && o.message ? o.message
    : typeof o.errorMessage === "string" && o.errorMessage ? o.errorMessage
    : typeof e === "string" ? e : code;
  return { code, message: msg };
}

/** True when `e` is a `KeystoreError` (what every method below rejects with). */
export function isKeystoreError(e: unknown): e is KeystoreError {
  return !!e && typeof e === "object" && (KEYSTORE_CODES as readonly string[]).includes((e as { code?: unknown }).code as string)
    && typeof (e as { message?: unknown }).message === "string";
}

async function call<T>(fn: (p: Plugin) => Promise<T>): Promise<T> {
  const p = plugin();
  if (!p) throw { code: "unavailable", message: "no biometric keystore in this app" } satisfies KeystoreError;
  try {
    return await fn(p);
  } catch (e) {
    throw toKeystoreError(e);
  }
}

export const nativeKeystore = {
  /** Is the plugin here at all? False in every browser and in older APKs. */
  available(): boolean {
    return plugin() !== null;
  },
  /** Sensor, enrolment and StrongBox — no fingerprint asked. */
  status(): Promise<KeystoreStatus> {
    return call((p) => p.status());
  },
  has(o: { alias: string }): Promise<{ exists: boolean }> {
    return call(async (p) => ({ exists: !!(await p.has({ alias: o.alias }))?.exists }));
  },
  /** Make the key (`strongBox` defaults to true, falling back to the TEE).
   *  Rejects `exists` over an existing alias unless `replace`.
   *  Resolves with whether it landed in StrongBox (else the TEE). */
  generate(o: { alias: string; strongBox?: boolean; replace?: boolean }): Promise<{ strongBox: boolean }> {
    return call(async (p) => ({ strongBox: !!(await p.generate(o))?.strongBox }));
  },
  /** One fingerprint: AES-GCM-encrypt `dataB64` (aad optional). The nonce is
   *  chosen by the Keystore; `ctB64` includes the 128-bit tag. */
  wrap(o: { alias: string; dataB64: string; aadB64?: string } & PromptText): Promise<{ ctB64: string; nonceB64: string }> {
    return call((p) => p.wrap(o));
  },
  /** One fingerprint: decrypt what `wrap` produced, with the same aad. */
  unwrap(o: { alias: string; ctB64: string; nonceB64: string; aadB64?: string } & PromptText): Promise<{ dataB64: string }> {
    return call((p) => p.unwrap(o));
  },
  remove(o: { alias: string }): Promise<void> {
    return call(async (p) => { await p.remove({ alias: o.alias }); });
  },
};
export type NativeKeystore = typeof nativeKeystore;
