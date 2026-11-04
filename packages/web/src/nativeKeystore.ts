/**
 * A key on this phone that only the person at it can use — the page's half of
 * `ShellKeystorePlugin` (packages/app). Generic: it wraps and unwraps bytes and
 * knows nothing about what they are for.
 *
 * The key is AES-256-GCM inside the Android Keystore (StrongBox when there is
 * one), in one of two kinds. The default (`auth: "biometric"`, and every key an
 * older shell made) is bound per use to a STRONG biometric and invalidated when
 * a new fingerprint is enrolled. `generate({auth: "any"})` is opened by a
 * fingerprint OR the phone's PIN, pattern or password: it needs a screen lock,
 * not a finger, a new fingerprint leaves it alone, and removing or changing the
 * screen lock destroys it. Either way every `wrap` / `unwrap` shows the system's
 * sheet; nothing here can use the key without one.
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
import { PLAIN_ROUTE_NO_FINGERPRINT } from "@waterplane/shared";
import { plainHostRoute } from "./hostUrl.ts";
import { nativePlugin } from "./shellBridge.ts";

/** The refusal words. All but `unavailable` come from the shell. */
export const KEYSTORE_CODES = [
  "unavailable", // no plugin: a browser, or an APK older than it
  "noHardware", // no usable strong biometric on this phone, or one down for a moment; an `any` key does not need one
  "noneEnrolled", // biometric key: hardware, but no fingerprint enrolled. `any` key: no screen lock
  "keyInvalidated", // biometric key: a fingerprint was enrolled since. `any` key: the screen lock changed. Gone for good; a dead key an OEM words its own way reads `failed`
  "noKey", // no key under that alias
  "exists", // generate() without replace over an existing alias
  "cancelled", // the person (or the system) dismissed the sheet
  "lockout", // too many failed attempts; biometrics locked for now
  "plainRoute", // refused HERE, not by the shell: the desktop is reached over plain HTTP
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

/** A fresh reading for the lock, no sheet shown. Only a shell with `authenticate`
 *  answers. Unlike `status()`, `hardware` is false only for a sensor truly absent. */
export interface KeystoreLockStatus {
  hardware: boolean;
  /** False proves little alone: a down sensor or a lockout reads false too. */
  enrolled: boolean;
  /** The phone has a PIN, pattern or password. */
  screenLock: boolean;
}

/** How the sheet was passed. Said for the record; nothing may branch on it. */
export interface KeystoreAuthResult {
  method: "biometric" | "credential" | "unknown";
}

/** What opens a key: a strong biometric, or (`any`) the phone's PIN too. */
export type KeystoreKeyAuth = "biometric" | "any";
export interface KeystoreGenerate { alias: string; strongBox?: boolean; replace?: boolean; auth?: KeystoreKeyAuth }

type Plugin = {
  status(): Promise<KeystoreStatus>;
  has(o: { alias: string }): Promise<{ exists: boolean }>;
  generate(o: KeystoreGenerate): Promise<{ strongBox: boolean; auth?: KeystoreKeyAuth }>;
  wrap(o: { alias: string; dataB64: string; aadB64?: string } & PromptText): Promise<{ ctB64: string; nonceB64: string }>;
  unwrap(o: { alias: string; ctB64: string; nonceB64: string; aadB64?: string } & PromptText): Promise<{ dataB64: string }>;
  remove(o: { alias: string }): Promise<void>;
  /** Absent on a shell older than them: feature-detected, never assumed. */
  authenticate?(o: PromptText & { allowCredential?: boolean }): Promise<KeystoreAuthResult>;
  lockStatus?(): Promise<KeystoreLockStatus>;
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

const UNAVAILABLE = { code: "unavailable", message: "no biometric keystore in this app" } satisfies KeystoreError;

async function call<T>(fn: (p: Plugin) => Promise<T>): Promise<T> {
  const p = plugin();
  if (!p) throw UNAVAILABLE;
  try {
    return await fn(p);
  } catch (e) {
    throw toKeystoreError(e);
  }
}

/**
 * A fingerprint is the one thing a forged page must not be able to ask for, and
 * on plain HTTP a person on the network can forge what the page shows. So every
 * use of the key stops here, whichever screen asked: ONE gate, not one per card.
 */
function sealedCall<T>(fn: (p: Plugin) => Promise<T>): Promise<T> {
  if (plugin() && plainHostRoute()) {
    return Promise.reject({ code: "plainRoute", message: PLAIN_ROUTE_NO_FINGERPRINT } satisfies KeystoreError);
  }
  return call(fn);
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
   *  Resolves with whether it landed in StrongBox (else the TEE). `auth` asks for that kind of key,
   *  and comes back only from a shell that made one: absent means an older shell ignored the ask
   *  and the key is biometric. */
  generate(o: KeystoreGenerate): Promise<{ strongBox: boolean; auth?: KeystoreKeyAuth }> {
    return call(async (p) => {
      const r = await p.generate(o);
      return { strongBox: !!r?.strongBox, ...(r?.auth === "biometric" || r?.auth === "any" ? { auth: r.auth } : {}) };
    });
  },
  /** One fingerprint: AES-GCM-encrypt `dataB64` (aad optional). The nonce is
   *  chosen by the Keystore; `ctB64` includes the 128-bit tag. */
  wrap(o: { alias: string; dataB64: string; aadB64?: string } & PromptText): Promise<{ ctB64: string; nonceB64: string }> {
    return sealedCall((p) => p.wrap(o));
  },
  /** One fingerprint: decrypt what `wrap` produced, with the same aad. */
  unwrap(o: { alias: string; ctB64: string; nonceB64: string; aadB64?: string } & PromptText): Promise<{ dataB64: string }> {
    return sealedCall((p) => p.unwrap(o));
  },
  remove(o: { alias: string }): Promise<void> {
    return call(async (p) => { await p.remove({ alias: o.alias }); });
  },
  /** Does this shell have the keyless prompt below? False on every APK before it. */
  canAuthenticate(): boolean {
    return typeof plugin()?.authenticate === "function";
  },
  /** One system sheet, no key behind it: a presence check. `allowCredential`
   *  (default true) lets it offer the phone's PIN. Rejects `unavailable` on an older shell.
   *  Not sealed: it uses no key and approves nothing a forged page could have worded. */
  authenticate(o: PromptText & { allowCredential?: boolean }): Promise<KeystoreAuthResult> {
    return call(async (p) => {
      if (!p.authenticate) throw UNAVAILABLE;
      return p.authenticate(o);
    });
  },
  /** A fresh reading, nothing asked of the person; safe while a sheet is up.
   *  Rejects `failed` when no reading can be made, `unavailable` on an older shell. */
  lockStatus(): Promise<KeystoreLockStatus> {
    return call(async (p) => {
      if (!p.lockStatus) throw UNAVAILABLE;
      return p.lockStatus();
    });
  },
};
export type NativeKeystore = typeof nativeKeystore;
