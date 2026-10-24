/**
 * The text-in-marks extension's pure half (node-tested, `logic.test.mjs`): what the assets folder's
 * manifest says, which of its files THIS phone needs, whether a download is right (sha256 — in
 * plain JS too, because a plain-http page has no `crypto.subtle`), how the reader's words are
 * cleaned, and every sentence the Settings row says.
 */

export const OCR_ID = "ocr";
/** Word confidence (0–100, tesseract's) below which a word is dropped rather than guessed. */
export const MIN_CONFIDENCE = 60;
/** The longest reading kept; longer is cut at a word and ends in `…`. */
export const MAX_CHARS = 200;
/** How long the worker stays warm after its last read. */
export const WARM_MS = 60_000;

export type AssetRole = "worker" | "core" | "core-simd" | "lang";
export interface AssetFile { file: string; role: AssetRole; bytes: number; sha256: string; lang?: string; name?: string }
export interface AssetManifest { files: AssetFile[] }

const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ROLES = new Set<AssetRole>(["worker", "core", "core-simd", "lang"]);

/** The folder's `manifest.json`, checked; null when it is not one this build can use. */
export function parseManifest(raw: unknown): AssetManifest | null {
  const files = (raw as { format?: unknown; files?: unknown } | null);
  if (!files || files.format !== 1 || !Array.isArray(files.files)) return null;
  const out: AssetFile[] = [];
  for (const f of files.files as unknown[]) {
    const o = f as Partial<AssetFile> | null;
    if (!o || typeof o.file !== "string" || !FILE.test(o.file) || !ROLES.has(o.role as AssetRole)) return null;
    if (typeof o.bytes !== "number" || !(o.bytes > 0) || typeof o.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(o.sha256)) return null;
    if (o.role === "lang" && (typeof o.lang !== "string" || !/^[a-z_]{3,10}$/.test(o.lang))) return null;
    out.push({ file: o.file, role: o.role as AssetRole, bytes: o.bytes, sha256: o.sha256, ...(o.lang ? { lang: o.lang } : {}), ...(typeof o.name === "string" ? { name: o.name } : {}) });
  }
  return out.some((f) => f.role === "worker") && out.some((f) => f.role === "core") && out.some((f) => f.role === "lang") ? { files: out } : null;
}

/** What THIS phone downloads: the worker, ONE core (the SIMD build where the phone runs it, else
 *  the plain one) and every language. The other core is never fetched. */
export function wantedFiles(m: AssetManifest, simd: boolean): AssetFile[] {
  const core = (simd && m.files.find((f) => f.role === "core-simd")) || m.files.find((f) => f.role === "core");
  return m.files.filter((f) => f.role === "worker" || f.role === "lang" || f === core);
}

export const langCodes = (files: readonly AssetFile[]): string[] => files.filter((f) => f.role === "lang").map((f) => f.lang!);
export const langNames = (files: readonly AssetFile[]): string[] => files.filter((f) => f.role === "lang").map((f) => f.name ?? f.lang!);
export const totalBytes = (files: readonly { bytes: number }[]): number => files.reduce((n, f) => n + f.bytes, 0);

/** `3.1` — megabytes, one decimal (decimal MB, as a phone's storage screen counts). */
export const mb = (bytes: number): string => (bytes / 1e6).toFixed(1);

/** `English + German`. */
export const langWords = (names: readonly string[]): string => names.join(" + ");

export const progressLine = (i: number, n: number, done: number, total: number): string =>
  `Downloading ${i} of ${n} · ${mb(done)} of ${mb(total)} MB`;

export const readyLine = (names: readonly string[], bytes: number): string =>
  `Ready · ${langWords(names)} · ${mb(bytes)} MB, works offline`;

/** What the row says when switched off and a download is still on this phone. */
export const keptLine = (bytes: number): string =>
  `Off. Its reader (${mb(bytes)} MB) is still on this phone — delete it, or keep it for when you switch it back on.`;

export const OFF_LINE = "Off. Switch it on in Settings › Tools & diagnostics › plugins (Text in marks): it downloads its reader (English + German, about 8 MB) from this desktop once and then works offline.";

/** The words a failed download says — the desktop's own refusal where it gave one. */
export function downloadError(status: number | null, said: string | null): string {
  if (status === null) return "The desktop could not be reached to download the reader.";
  if (said) return `The desktop refused the download: ${said}.`;
  return `The desktop answered ${status} for the reader's files.`;
}

// ── the reading ───────────────────────────────────────────────────────────

export interface Word { text: string; confidence: number }

/** Every word of tesseract's `blocks` output, in reading order. Absent shapes are no words. */
export function wordsOf(blocks: unknown): Word[] {
  const out: Word[] = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    for (const p of Array.isArray(b?.paragraphs) ? b.paragraphs : []) {
      for (const l of Array.isArray(p?.lines) ? p.lines : []) {
        for (const w of Array.isArray(l?.words) ? l.words : []) {
          if (typeof w?.text === "string" && typeof w?.confidence === "number") out.push({ text: w.text, confidence: w.confidence });
        }
      }
    }
  }
  return out;
}

/** The reading as the note will quote it: confident words only, whitespace flattened, at most
 *  `MAX_CHARS` (cut at a word, `…`). Nothing confident ⇒ null — absent, never a guess. */
export function cleanText(words: readonly Word[]): string | null {
  const kept = words.filter((w) => w.confidence >= MIN_CONFIDENCE).map((w) => w.text.replace(/\s+/g, " ").trim()).filter((t) => /[\p{L}\p{N}]/u.test(t));
  const s = kept.join(" ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (s.length <= MAX_CHARS) return s;
  const cut = s.slice(0, MAX_CHARS);
  const at = cut.lastIndexOf(" ");
  return `${(at > MAX_CHARS / 2 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

// ── checking a download ───────────────────────────────────────────────────

/** The tiny module wasm-feature-detect validates for 128-bit SIMD. */
export const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 in plain JS, hex — the fallback where `crypto.subtle` is absent (not a secure context). */
export function sha256HexSync(data: Uint8Array): string {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const len = data.length;
  const tail = new Uint8Array(128);
  // Build the padded final block(s) separately so the input is never copied whole.
  const fullBlocks = Math.floor(len / 64);
  const rem = len - fullBlocks * 64;
  tail.set(data.subarray(fullBlocks * 64));
  tail[rem] = 0x80;
  const tailLen = rem + 9 > 64 ? 128 : 64;
  const bits = len * 8;
  const dv = new DataView(tail.buffer);
  dv.setUint32(tailLen - 8, Math.floor(bits / 0x100000000));
  dv.setUint32(tailLen - 4, bits >>> 0);
  const block = (buf: Uint8Array, off: number) => {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (buf[j]! << 24) | (buf[j + 1]! << 16) | (buf[j + 2]! << 8) | buf[j + 3]!;
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!, b = w[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0]! + a) | 0; h[1] = (h[1]! + b) | 0; h[2] = (h[2]! + c) | 0; h[3] = (h[3]! + d) | 0;
    h[4] = (h[4]! + e) | 0; h[5] = (h[5]! + f) | 0; h[6] = (h[6]! + g) | 0; h[7] = (h[7]! + hh) | 0;
  };
  for (let i = 0; i < fullBlocks; i++) block(data, i * 64);
  for (let off = 0; off < tailLen; off += 64) block(tail, off);
  return [...h].map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
}

/** SHA-256 hex: WebCrypto where the page has it, the plain-JS one where it does not. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (subtle) {
    try {
      const d = await subtle.digest("SHA-256", data as unknown as BufferSource);
      return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch { /* fall through to the plain one */ }
  }
  return sha256HexSync(data);
}
