/**
 * "Put this file where a file manager can see it" — the Android-shell half.
 *
 * In a browser, saving a Blob is a hidden `<a download href="blob:…">` click and
 * the browser takes it from there. **Inside the Capacitor WebView that does
 * nothing at all**: no download listener, no error, no file. The tap looked like
 * it worked, and the 23 MB APK the phone had spent an hour pulling down existed
 * only inside IndexedDB, where nothing else on the phone can reach it. A native
 * `DownloadListener` does not rescue it either — a `blob:` URL lives in the
 * renderer and cannot be handed to Android's `DownloadManager`.
 *
 * So the bytes go across the bridge, in slices, and `ShellSavePlugin` writes them
 * into the phone's Downloads.
 *
 * Two things worth keeping:
 *
 *  - **Sliced, not one call.** Base64 of a 23 MB APK is ~31 MB of JSON string.
 *    One call would peak at several times that across both sides; a slice at a
 *    time is flat in the file's size.
 *  - **A failed save is aborted, not abandoned.** The partial file lives in the
 *    app's cache until `finish` publishes it, so giving up without `abort` would
 *    leave megabytes there until the sweeper notices.
 *
 * As with `hostUrl.ts` and `webUpdate.ts`, the plugin is reached off the global
 * Capacitor injects rather than an npm import: no native-shell dependency enters
 * the bundle every browser downloads.
 */
import { nativePlugin } from "./shellBridge";
import { isNativeShell } from "./hostUrl";

/** Bytes per bridge call. 512 KiB ⇒ ~700 KB of base64 per message: big enough
 *  that a 23 MB APK is ~46 calls, small enough to stay off the phone's radar. */
const CHUNK = 512 * 1024;
/** `String.fromCharCode` takes its input as arguments, so the byte→string step
 *  is itself chunked or a slice this size blows the argument limit. */
const B64_CHUNK = 8192;

type Plugin = {
  begin(opts: { name: string; mime: string }): Promise<{ token: string }>;
  chunk(opts: { token: string; dataBase64: string }): Promise<void>;
  finish(opts: { token: string }): Promise<{ where: string }>;
  abort(opts: { token: string }): Promise<void>;
  /** Added after the first APK that shipped this plugin — an older shell has
   *  `begin` and not this, which is why every caller checks for it by name. */
  find?(opts: { name: string; size?: number }): Promise<FoundFile>;
};

/** What Downloads holds for a name (`present: false` = nothing that matches). */
export interface FoundFile {
  present: boolean;
  /** "Downloads/app-debug (5).apk" — what MediaStore actually called it. */
  where?: string;
  size?: number;
  modified?: number;
}

function plugin(): Plugin | null {
  const p = nativePlugin<Plugin>("Save");
  return p && typeof p.begin === "function" ? p : null;
}

/** Can this device save a blob to a real file? False in every browser, where
 *  the anchor-click path is the right one and already works. */
export function nativeSaveSupported(): boolean {
  return isNativeShell() && plugin() !== null;
}

/** Can this shell be ASKED what is in Downloads? A separate question from
 *  saving: the APK is updated by installing one, the UI over the air, so a
 *  phone runs a bundle whose plugin predates `find` for as long as it likes.
 *  Unknown ⇒ the app says nothing about the folder, which is what it did
 *  before. */
export function nativeFindSupported(): boolean {
  return isNativeShell() && typeof plugin()?.find === "function";
}

/**
 * Is this file already sitting in the phone's Downloads?
 *
 * The one question the save path never asked. Its two answers are the two
 * things the user could not see: a file already there does not need saving
 * again (each re-save is another "app-debug (5).apk", and 90 MB across the
 * bridge to make it), and a file NOT there any more must stop being described
 * as saved.
 *
 * `size` is what makes the answer about these BYTES rather than this name — an
 * APK keeps its name across every build. Null when the shell cannot answer at
 * all; `present: false` is a real answer and means the folder was read.
 */
export async function findInDownloads(name: string, size?: number): Promise<FoundFile | null> {
  const p = plugin();
  if (!p?.find) return null;
  try {
    const r = await p.find({ name, size: size || undefined });
    return { present: !!r?.present, where: r?.where, size: r?.size, modified: r?.modified };
  } catch {
    // A refused query is not "the file is gone". Say nothing.
    return null;
  }
}

/**
 * Write a blob into the phone's Downloads. Resolves with where it landed, in
 * the form the UI shows the user ("Downloads/thing.apk") — read back from
 * MediaStore, because it renames a colliding file and the name it chose is the
 * one the user has to look for.
 */
export async function saveToDownloads(blob: Blob, name: string): Promise<string> {
  const p = plugin();
  if (!p) throw new Error("no native save on this device");
  const { token } = await p.begin({ name, mime: blob.type || "" });
  try {
    for (let off = 0; off < blob.size; off += CHUNK) {
      const buf = await blob.slice(off, Math.min(off + CHUNK, blob.size)).arrayBuffer();
      await p.chunk({ token, dataBase64: toBase64(buf) });
    }
    const { where } = await p.finish({ token });
    return where;
  } catch (e) {
    // Best effort: the staging file is in the cache and swept eventually, but
    // leaving 23 MB there until then is not free on a phone.
    try { await p.abort({ token }); } catch { /* the save already failed; this is cleanup */ }
    throw e;
  }
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(s);
}
