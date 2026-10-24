/**
 * The reader's files on this phone: downloaded from the desktop when the person switches the
 * extension ON (`index.ts` boot watches the switch), checked byte for byte against the folder's
 * `manifest.json` (size + sha256), and kept in IndexedDB (`extAssets`) for offline use — the one
 * store a secure browser, the Android shell and a plain-http page all have.
 *
 * `ocrState` is the row's whole truth; this module is its ONE writer. Nothing is deleted without
 * a tap except files this phone no longer needs (the other core build, a file the desktop's
 * manifest dropped) — the off-offer (`forget`) is the person's.
 */
import { createStore, extAssets, extStorage } from "@waterplane/sdk";
import { downloadError, langCodes, langNames, OCR_ID, parseManifest, progressLine, readyLine, SIMD_PROBE, sha256Hex, totalBytes, wantedFiles, type AssetFile, type AssetManifest } from "./logic.ts";
import type { EngineFiles } from "./engine.ts";

export type OcrState =
  | { k: "off"; kept: number | null }
  | { k: "checking" }
  | { k: "downloading"; line: string }
  | { k: "ready"; line: string; bytes: number }
  | { k: "error"; error: string };

export const ocrState = createStore<OcrState>({ k: "off", kept: null });

const files = extAssets(OCR_ID);
const mem = extStorage(OCR_ID);
const MANIFEST = "manifest.json";
/** The sha256 each stored file was VERIFIED against when it was written: a file is trusted on a
 *  later start when its size and this record match the manifest, without hashing 8 MB again. */
const VERIFIED = "verified";
/** A body that delivers nothing for this long is a dead link, not a slow one. */
const STALL_MS = 30_000;

let run = 0;
let ac: AbortController | null = null;

const simd = (): boolean => {
  try { return typeof WebAssembly === "object" && WebAssembly.validate(SIMD_PROBE); } catch { return false; }
};

async function said(r: Response): Promise<string | null> {
  try { const j = await r.json() as { error?: unknown }; return typeof j.error === "string" ? j.error : null; } catch { return null; }
}

/** Stream one file, saying progress; resolves its bytes, or throws the sentence. */
async function pull(f: AssetFile, signal: AbortSignal, onBytes: (n: number) => void): Promise<Blob> {
  let r: Response;
  try { r = await files.fetch(f.file, signal); } catch { throw new Error(downloadError(null, null)); }
  if (!r.ok) throw new Error(downloadError(r.status, await said(r)));
  if (!r.body) { const b = await r.blob(); onBytes(b.size); return b; }
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  const cancel = () => { void reader.cancel().catch(() => { /* gone */ }); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      let stall: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, no) => { stall = setTimeout(() => { cancel(); no(new Error("The download stalled — the desktop stopped sending.")); }, STALL_MS); }),
      ]).finally(() => clearTimeout(stall));
      if (next.done) break;
      parts.push(next.value);
      got += next.value.length;
      onBytes(got);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  if (signal.aborted) throw new Error("stopped");
  return new Blob(parts as BlobPart[]);
}

async function storedOk(f: AssetFile, verified: Record<string, string>): Promise<boolean> {
  if (verified[f.file] !== f.sha256) return false;
  const b = await files.get(f.file);
  return !!b && b.size === f.bytes;
}

async function storedManifest(): Promise<AssetManifest | null> {
  const b = await files.get(MANIFEST);
  if (!b) return null;
  try { return parseManifest(JSON.parse(await b.text())); } catch { return null; }
}

/** The desktop's manifest, or — offline — the one kept with the files. */
async function currentManifest(signal: AbortSignal): Promise<{ m: AssetManifest; fresh: Blob | null }> {
  let r: Response | null = null;
  try { r = await files.fetch(MANIFEST, signal); } catch { r = null; }
  if (r?.ok) {
    const b = await r.blob();
    let m: AssetManifest | null = null;
    try { m = parseManifest(JSON.parse(await b.text())); } catch { m = null; }
    if (!m) throw new Error("The desktop's reader files are from a version this app cannot use — update the desktop.");
    return { m, fresh: b };
  }
  const kept = await storedManifest();
  if (kept) return { m: kept, fresh: null };
  throw new Error(r ? downloadError(r.status, await said(r)) : downloadError(null, null));
}

/** Switched on (or a retry): make sure every file this phone needs is here and right. */
export async function ensure(): Promise<void> {
  const mine = ++run;
  ac?.abort();
  ac = new AbortController();
  const signal = ac.signal;
  const live = () => mine === run;
  ocrState.set({ k: "checking" });
  try {
    const { m, fresh } = await currentManifest(signal);
    const want = wantedFiles(m, simd());
    const verified = { ...mem.read<Record<string, string>>(VERIFIED, {}) };
    const need: AssetFile[] = [];
    for (const f of want) if (!(await storedOk(f, verified))) need.push(f);
    if (need.length && !fresh) throw new Error(downloadError(null, null));
    const total = totalBytes(need);
    let before = 0;
    for (let i = 0; i < need.length; i++) {
      const f = need[i]!;
      if (!live()) return;
      ocrState.set({ k: "downloading", line: progressLine(i + 1, need.length, before, total) });
      const blob = await pull(f, signal, (n) => { if (live()) ocrState.set({ k: "downloading", line: progressLine(i + 1, need.length, before + n, total) }); });
      if (blob.size !== f.bytes) throw new Error(`${f.file} arrived with ${blob.size} bytes instead of ${f.bytes} — not kept. Try again.`);
      if ((await sha256Hex(new Uint8Array(await blob.arrayBuffer()))) !== f.sha256) throw new Error(`${f.file} did not match the desktop's checksum — not kept. Try again.`);
      if (!(await files.put(f.file, blob))) throw new Error("This phone would not store the reader (out of space, or storage is blocked for this page).");
      verified[f.file] = f.sha256;
      mem.write(VERIFIED, verified);
      before += f.bytes;
    }
    if (fresh) await files.put(MANIFEST, fresh);
    // What this phone no longer needs: the other core build, a file the desktop dropped.
    const keep = new Set([MANIFEST, ...want.map((f) => f.file)]);
    for (const name of await files.list()) if (!keep.has(name)) { await files.remove(name); delete verified[name]; }
    mem.write(VERIFIED, verified);
    if (live()) ocrState.set({ k: "ready", bytes: totalBytes(want), line: readyLine(langNames(want), totalBytes(want)) });
  } catch (e) {
    if (live() && !signal.aborted) ocrState.set({ k: "error", error: (e as Error).message || "The reader could not be downloaded." });
  }
}

/** Switched off: stop any download, and say what is still on this phone. */
export async function switchedOff(): Promise<void> {
  const mine = ++run;
  ac?.abort();
  ac = null;
  ocrState.set({ k: "off", kept: null });
  const kept = await keptBytes();
  if (mine === run) ocrState.set({ k: "off", kept });
}

async function keptBytes(): Promise<number> {
  let n = 0;
  for (const name of await files.list()) n += (await files.get(name))?.size ?? 0;
  return n;
}

/** The off-offer, after the person confirmed: delete every downloaded file. */
export async function forget(): Promise<boolean> {
  const mine = ++run;
  const ok = await files.clear();
  mem.remove(VERIFIED);
  const kept = await keptBytes();
  if (mine === run) ocrState.set({ k: "off", kept });
  return ok && kept === 0;
}

/** What the engine starts from: the verified files, or null when any is missing. */
export async function engineFiles(): Promise<EngineFiles | null> {
  const m = await storedManifest();
  if (!m) return null;
  const want = wantedFiles(m, simd());
  const verified = mem.read<Record<string, string>>(VERIFIED, {});
  const get = async (f: AssetFile | undefined) => (f && verified[f.file] === f.sha256 ? files.get(f.file) : null);
  const worker = await get(want.find((f) => f.role === "worker"));
  const core = await get(want.find((f) => f.role === "core" || f.role === "core-simd"));
  if (!worker || !core) return null;
  const langs: EngineFiles["langs"] = [];
  for (const code of langCodes(want)) {
    const data = await get(want.find((f) => f.lang === code));
    if (!data) return null;
    langs.push({ code, data });
  }
  return { worker, core, langs };
}
