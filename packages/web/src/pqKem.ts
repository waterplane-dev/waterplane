/**
 * ML-KEM-768 (FIPS 203) on this phone — a post-quantum key encapsulation, generic: it makes a key
 * pair, encapsulates a 32-byte shared secret to someone's encapsulation key, and decapsulates one
 * sent to ours. It knows nothing about what the secret is for; a caller hybridises it with a
 * classical exchange (ECDH) so the result holds while EITHER does.
 *
 * WebCrypto's own ML-KEM when the WebView has it (`crypto.subtle` "ML-KEM-768", feature-detected
 * once by actually making a key), else the audited pure-JS `@noble/post-quantum`. Its module is
 * EVALUATED only when a phone without native ML-KEM first needs it (a dynamic import), but it is
 * PACKAGED in the static vendor chunk like every dependency (`vite.config.ts`'s `vendorChunk`), so it
 * is on the phone when the link is gone. Keys travel raw: the 1184-byte encapsulation key, the 1088-byte ciphertext, the 32-byte
 * secret. The private half stays inside the closure (a non-extractable CryptoKey, or noble's bytes).
 */

export interface PqKemPair { ek: Uint8Array; decapsulate(ct: Uint8Array): Promise<Uint8Array> }
export interface PqKem {
  /** Which implementation answered: "webcrypto ML-KEM-768" or "noble ML-KEM-768". */
  readonly name: string;
  keygen(): Promise<PqKemPair>;
  encapsulate(ek: Uint8Array): Promise<{ ct: Uint8Array; ss: Uint8Array }>;
}

const ALG = { name: "ML-KEM-768" };
type KemSubtle = {
  generateKey(a: typeof ALG, extractable: boolean, uses: string[]): Promise<CryptoKeyPair>;
  exportKey(f: "raw-public", k: CryptoKey): Promise<ArrayBuffer>;
  importKey(f: "raw-public", d: Uint8Array, a: typeof ALG, extractable: boolean, uses: string[]): Promise<CryptoKey>;
  encapsulateBits(a: typeof ALG, k: CryptoKey): Promise<{ ciphertext: ArrayBuffer; sharedKey: ArrayBuffer }>;
  decapsulateBits(a: typeof ALG, k: CryptoKey, ct: Uint8Array): Promise<ArrayBuffer>;
};

/** WebCrypto ML-KEM-768 over a `subtle` that has it. Exported for the interop test. */
export function subtleKem(subtle: unknown): PqKem {
  const s = subtle as KemSubtle;
  return {
    name: "webcrypto ML-KEM-768",
    async keygen() {
      const kp = await s.generateKey(ALG, false, ["encapsulateBits", "decapsulateBits"]);
      const ek = new Uint8Array(await s.exportKey("raw-public", kp.publicKey));
      return { ek, decapsulate: async (ct) => new Uint8Array(await s.decapsulateBits(ALG, kp.privateKey, new Uint8Array(ct))) };
    },
    async encapsulate(ek) {
      const pk = await s.importKey("raw-public", new Uint8Array(ek), ALG, true, ["encapsulateBits"]);
      const r = await s.encapsulateBits(ALG, pk);
      return { ct: new Uint8Array(r.ciphertext), ss: new Uint8Array(r.sharedKey) };
    },
  };
}

/** The pure-JS one. Exported for the interop test. */
export async function nobleKem(): Promise<PqKem> {
  const { ml_kem768 } = await import("@noble/post-quantum/ml-kem.js");
  return {
    name: "noble ML-KEM-768",
    async keygen() {
      const { publicKey, secretKey } = ml_kem768.keygen();
      return { ek: publicKey, decapsulate: async (ct) => ml_kem768.decapsulate(new Uint8Array(ct), secretKey) };
    },
    async encapsulate(ek) {
      const { cipherText, sharedSecret } = ml_kem768.encapsulate(new Uint8Array(ek));
      return { ct: cipherText, ss: sharedSecret };
    },
  };
}

/** Does this `subtle` really do ML-KEM-768? A round trip, not a property check. */
async function works(k: PqKem): Promise<boolean> {
  try {
    const p = await k.keygen();
    const { ct, ss } = await k.encapsulate(p.ek);
    const back = await p.decapsulate(ct);
    return p.ek.length === 1184 && ct.length === 1088 && ss.length === 32 && back.every((x, i) => x === ss[i]);
  } catch { return false; }
}

let chosen: Promise<PqKem> | null = null;

/** The ML-KEM-768 this page uses: native when it works, else noble. Decided once per page. */
export function pqKem(): Promise<PqKem> {
  chosen ??= (async () => {
    const subtle = globalThis.crypto?.subtle;
    if (subtle && typeof (subtle as unknown as Partial<KemSubtle>).encapsulateBits === "function") {
      const k = subtleKem(subtle);
      if (await works(k)) return k;
    }
    return nobleKem();
  })();
  return chosen;
}
