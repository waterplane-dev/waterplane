/**
 * **May this phone take what a desktop's manifest offers?** The whole policy
 * table of the signed web bundle, and every sentence a refusal says, as pure
 * logic. `updatePins.ts` feeds it facts and acts on the answer; `webUpdate.ts`
 * does the transfer. No DOM and no local-module value imports: the web unit-test
 * layer runs this file off the TypeScript directly.
 *
 * Four rules the shape comes from:
 *
 *  - **Only what is inside `signed` counts.** The bytes verified are the bytes
 *    parsed, decoded once, so there is nothing to canonicalise and no second copy
 *    of the file list for a relay to edit. The manifest's outer fields are never
 *    read on the signed path.
 *  - **The same checks as `ShellBundleVerify.parse`, on purpose.** This layer
 *    works on shipped APKs; the native one is the backstop for page code that is
 *    already compromised. A manifest refused here costs no download, and one
 *    refused only there costs a whole bundle.
 *  - **`gen` 0 is a pin, not a missing one.** A key is pinned at 0 and the first
 *    signed `gen` is 1, so nothing here tests `gen` for truth. `gen` comes down
 *    only through a person's answer (`updatePins.ts`).
 *  - **A signed manifest with no way to learn a key is today's behaviour.** A
 *    passive device opens no socket, so a welcome can never reach it, and
 *    "wait for the key" would be a lockout. Its route is protected or this code
 *    would not be running, which is everything the app had before keys existed.
 */
import { isHostId } from "@waterplane/shared";

/** One file of a bundle (`host/webbundle.ts`). */
export interface BundleFile {
  path: string;
  size: number;
  sha256: string;
}

/** The inside of `signed`. */
export interface SignedBody {
  v: 1;
  hostId: string;
  buildId: string;
  gen: number;
  total: number;
  files: BundleFile[];
}

/** One row of `ShellUpdate.info().updateKeys`. */
export interface NativePin {
  hostId: string;
  key: string;
  gen: number;
}

/** A key a welcome stated, on a socket whose own address was protected. */
export interface OfferedKey {
  hostId: string;
  key: string;
}

export interface GateFacts {
  signed?: unknown;
  sig?: unknown;
  /** The active row's `hostId`, once a protected welcome named it. */
  rowHostId: string | null;
  /** The active row's pin. */
  pin: { key: string; gen: number } | null;
  /** The native pin store; null on an APK with no native verification. */
  shell: NativePin[] | null;
  offered: OfferedKey | null;
  /** A key can still reach this phone: there is a row to keep it on and a socket to bring it. */
  canLearn: boolean;
  subtle?: SubtleCrypto;
}

export type Refusal =
  | "unsigned" | "unsigned-elsewhere" | "bad-signature" | "wrong-host" | "bad-manifest" | "rollback"
  | "wrong-build" | "bad-files" | "not-verified" | "no-pin" | "no-key" | "bad-key";

/** What a person can answer. `pin`: allow this desktop. `key-changed`: allow its new key.
 *  `restored`: take a desktop whose `gen` went backwards. */
export type TrustAsk = "pin" | "key-changed" | "restored";

export type Gate =
  /** No pin and no signature: an older desktop, taken on the route alone as it always was. */
  | { v: "open" }
  | { v: "good"; body: SignedBody; key: string }
  /** This key needs a person (or, on a shipped APK, only a first look). */
  | { v: "pin"; hostId: string; key: string; change: boolean }
  | { v: "refuse"; why: Refusal; hostId?: string; key?: string };

const SIGNED_MAX = 1 << 20;
const PATH_MAX = 1024;
const SIG_BYTES = 64;
/** Everything before the point in a P-256 SPKI: the algorithm, the curve, the uncompressed marker. */
const P256_SPKI_HEADER = "3059301306072a8648ce3d020106082a8648ce3d030107034200";
const P256_SPKI_BYTES = 91;

/** Strict standard base64, the spelling `ShellBundleVerify` accepts. Null for anything else. */
export function unbase64(s: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof s !== "string" || !s || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  try {
    const raw = atob(s);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function hexOf(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Is this the SPKI of a P-256 public key? A junk key pinned on a shipped APK, where no native
 *  check stands behind it, would refuse every later update. */
export function goodUpdateKey(key: unknown): key is string {
  const b = unbase64(key);
  return !!b && b.length === P256_SPKI_BYTES && hexOf(b.subarray(0, P256_SPKI_HEADER.length / 2)) === P256_SPKI_HEADER;
}

function goodPath(p: unknown): p is string {
  if (typeof p !== "string" || !p || p.length > PATH_MAX) return false;
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x5c) return false;
  }
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

function count(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/** Read the decoded `signed` bytes. Null for anything `ShellBundleVerify.parse` would refuse. */
export function readSigned(bytes: Uint8Array): SignedBody | null {
  if (bytes.length > SIGNED_MAX) return null;
  let top: unknown;
  try { top = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return null; }
  if (!top || typeof top !== "object" || Array.isArray(top)) return null;
  const { v, hostId, buildId, gen, total, files } = top as Record<string, unknown>;
  if (v !== 1 || !isHostId(hostId) || typeof buildId !== "string" || !/^[a-f0-9]{8,64}$/.test(buildId)) return null;
  if (!count(gen) || !count(total) || !Array.isArray(files) || files.length === 0) return null;
  const rows: BundleFile[] = [];
  const seen = new Set<string>();
  let sum = 0;
  for (const row of files as unknown[]) {
    if (!row || typeof row !== "object") return null;
    const { path, size, sha256 } = row as Record<string, unknown>;
    if (!goodPath(path) || seen.has(path) || !count(size)) return null;
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) return null;
    seen.add(path);
    sum += size;
    if (!Number.isSafeInteger(sum)) return null;
    rows.push({ path, size, sha256 });
  }
  if (sum !== total || !seen.has("index.html")) return null;
  return { v: 1, hostId, buildId, gen, total, files: rows };
}

/** ECDSA P-256 SHA-256 over `bytes`; `sig` is P1363 `r‖s`, which is WebCrypto's own form. A key
 *  that will not import and a shell with no WebCrypto are both a no. */
export async function signatureOk(
  bytes: Uint8Array<ArrayBuffer>, sig: unknown, key: string,
  subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle,
): Promise<boolean> {
  const raw = unbase64(sig);
  const spki = unbase64(key);
  if (!subtle || !raw || raw.length !== SIG_BYTES || !spki) return false;
  try {
    const pub = await subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, raw, bytes);
  } catch {
    return false;
  }
}

const refuse = (why: Refusal, extra: { hostId?: string; key?: string } = {}): Gate => ({ v: "refuse", why, ...extra });

/**
 * The policy table, for a route already known to be protected (a plain route never gets here).
 * `pin` asks for a person, or on a shipped APK only a first look, and the caller then decides again.
 */
export async function decide(f: GateFacts): Promise<Gate> {
  const want = f.rowHostId ?? f.offered?.hostId ?? null;
  const nativeRow = want ? f.shell?.find((p) => p.hostId === want) : undefined;
  const held = f.pin ?? (nativeRow ? { key: nativeRow.key, gen: nativeRow.gen } : null);

  if (typeof f.signed !== "string" || !f.signed) {
    if (held) return refuse("unsigned");
    // The native gate is per phone, not per desktop: refused here it costs no download.
    if (f.shell?.length) return refuse("unsigned-elsewhere");
    return { v: "open" };
  }
  if (!held && !f.offered) {
    return f.canLearn || f.shell?.length ? refuse("no-key") : { v: "open" };
  }

  const bytes = unbase64(f.signed);
  const body = bytes && readSigned(bytes);
  if (!bytes || !body) return refuse("bad-manifest");
  const offered = f.offered;
  const offerSigned = async () => !!offered && offered.key !== held?.key && offered.hostId === body.hostId
    && await signatureOk(bytes, f.sig, offered.key, f.subtle);

  if (!held) {
    // Nothing is pinned yet, and a person is about to be shown this key: it has to be the one that
    // signed what is on offer.
    return await offerSigned() ? { v: "pin", hostId: body.hostId, key: offered!.key, change: false } : refuse("bad-signature");
  }
  if (!await signatureOk(bytes, f.sig, held.key, f.subtle)) {
    return await offerSigned() ? { v: "pin", hostId: body.hostId, key: offered!.key, change: true } : refuse("bad-signature");
  }
  if (want && body.hostId !== want) {
    // Signed by the held key, under a new id: a desktop that lost its LAN identity and kept its key.
    // Believed only with a protected welcome saying the same.
    return offered?.hostId === body.hostId && offered.key === held.key
      ? { v: "pin", hostId: body.hostId, key: held.key, change: true }
      : refuse("wrong-host");
  }
  const sameKey = f.shell?.find((p) => p.hostId === body.hostId && p.key === held.key);
  if (body.gen < Math.max(held.gen, sameKey?.gen ?? 0)) return refuse("rollback", { hostId: body.hostId, key: held.key });
  // The row holds a key the native store does not, so `finishBundle` would refuse a whole bundle.
  if (f.shell && !sameKey) return { v: "pin", hostId: body.hostId, key: held.key, change: false };
  return { v: "good", body, key: held.key };
}

/** `ws://host:port/ws` as the base the route rule reads. Null for what does not parse. */
export function baseOfDial(dialUrl: string): string | null {
  try {
    const u = new URL(dialUrl);
    const scheme = u.protocol === "wss:" ? "https:" : u.protocol === "ws:" ? "http:" : u.protocol;
    return `${scheme}//${u.host}`;
  } catch {
    return null;
  }
}

/** `ShellUpdatePlugin` writes this as `badReason` when the launch check drops a stored bundle. The
 *  bundle did not fail to start, so nothing may say it did (`tools`: pinned against the Java). */
export const NATIVE_UNVERIFIED_REASON = "it is not signed by a desktop this phone trusts";

/** The notice after that drop. It names no build: `badBuild` may be an older failure's. */
export const UNVERIFIED_FALLBACK =
  "The build this phone was running has no signature it can check against a desktop's key, so the app went back to the build inside it until a signed one arrives.";

const NOTHING_TAKEN = "Nothing was downloaded, and the app keeps the build it has.";
const NOTHING_KEPT = "Nothing was kept, and the app keeps the build it has.";

/**
 * Every refusal in words. **`unsigned` never says "update the desktop"**: a desktop that cannot
 * read its key file serves an unsigned manifest too (`host/webbundle.ts`), and an old version and a
 * full disk look the same from here.
 */
export const REFUSAL_WORDS: Record<Refusal, string> = {
  "unsigned": `This desktop sent its update with no signature, and this phone holds its key. ${NOTHING_TAKEN} A desktop on an older version does this, and so does one that cannot read its key file: its log says which.`,
  "unsigned-elsewhere": `This desktop sent its update with no signature, and this phone takes only signed updates since it allowed another desktop. ${NOTHING_TAKEN} A desktop on an older version does this, and so does one that cannot read its key file: its log says which.`,
  "bad-signature": `This update's signature does not match the key this phone holds for this desktop. ${NOTHING_TAKEN}`,
  "wrong-host": `This update names a different desktop than the one this phone is connected to. ${NOTHING_TAKEN}`,
  "bad-manifest": `This update's signed list of files cannot be read. ${NOTHING_TAKEN}`,
  "rollback": `This update is older than one this phone already took from this desktop. ${NOTHING_TAKEN} A desktop restored from a backup or rolled back does this, and so does an old update played again. If you did that to the desktop, tap "trust the restored desktop": you may be asked twice, to forget its key and then to allow it again.`,
  "wrong-build": `The signature is for a different build than the one that arrived. ${NOTHING_KEPT}`,
  "bad-files": `The files that arrived do not match what the desktop signed. ${NOTHING_KEPT} The next check tries again.`,
  "not-verified": `This phone could not confirm that build's signature, so it was not taken. The next check downloads it again.`,
  "no-pin": `This phone holds no key for this desktop yet. ${NOTHING_KEPT} Tap "allow this desktop", and the update downloads again.`,
  "no-key": `App updates wait for this desktop's key, which arrives with the next connection over the tailnet or an encrypted link. The app keeps the build it has.`,
  "bad-key": `The key this desktop offered is not a usable update key, so it was not kept. ${NOTHING_TAKEN}`,
};

/** What stands waiting on an answer a person has not given. */
export const ASK_WORDS: Record<Exclude<TrustAsk, "restored">, string> = {
  "pin": `App updates wait until you allow this desktop's key. The app keeps the build it has.`,
  "key-changed": `This desktop now signs its updates with a different key. A reinstalled desktop does this, and so does one pretending to be it. App updates wait until you allow the new key, and the app keeps the build it has.`,
};

export const TRUST_BUTTON: Record<TrustAsk, string> = {
  "pin": "allow this desktop",
  "key-changed": "allow the new key",
  "restored": "trust the restored desktop",
};

/** A refusal's way out, when a person holds one. */
export function askOf(why: Refusal): TrustAsk | undefined {
  return why === "rollback" ? "restored" : why === "no-pin" ? "pin" : undefined;
}

/** The notice for a refusal the person did not ask for: one sentence, and where the rest is. */
export const REFUSED_NOTICE = "An app update was refused. Settings › Connection › app version says why.";

const NATIVE_CODES: Record<string, Refusal> = {
  UNSIGNED: "unsigned",
  PIN_FIRST: "no-pin",
  NOT_PINNED: "no-pin",
  NOT_VERIFIED: "not-verified",
  BAD_SIGNATURE: "bad-signature",
  BAD_MANIFEST: "bad-manifest",
  WRONG_BUILD: "wrong-build",
  ROLLBACK: "rollback",
  BAD_FILES: "bad-files",
  BAD_KEY: "bad-key",
};

/** The refusal a rejected plugin call carries, or null for any other failure. */
export function nativeRefusal(e: unknown): Refusal | null {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && Object.hasOwn(NATIVE_CODES, code) ? NATIVE_CODES[code]! : null;
}
