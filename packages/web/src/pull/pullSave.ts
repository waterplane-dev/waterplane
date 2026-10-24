import { idbGet } from "../idb";
import { findInDownloads, nativeFindSupported, nativeSaveSupported, saveToDownloads } from "../nativeSave";
import { nativeFileUrl, nativeList, nativePublish } from "../nativePull";
import type { PullRecord, SaveResult, PullBlob } from "./pullTypes";
import { PUBLISH_WAIT_MS, PUBLISH_POLL_MS } from "./pullConsts";
import { typedBlob } from "./pullMime";
import type { PullManager } from "./pullManager";

// ── device-side delivery ──────────────────────────────────────────
/**
 * Hand a finished download to the phone's own Downloads. The bytes never touch
 * the network here — they are already on the device.
 *
 * Two paths, because the anchor click is not universal: in a browser it is
 * exactly right, and in the Capacitor WebView it does **nothing, silently** —
 * no listener, no error, no file (see `nativeSave.ts`). That was the whole bug:
 * "on phone · save" appeared to work in the APK and the file existed nowhere a
 * file manager could reach.
 *
 * The outcome is both returned and written onto the record, so a row can keep
 * saying where the file went after the toast is gone.
 */
export async function pullSave(this: PullManager, id: string): Promise<SaveResult> {
  const native = this.records[id];
  if (native?.engine === "native" && native.nativePath) return this.saveNative(id, native);
  const rec = await idbGet<PullBlob>("pulls", id);
  if (!rec?.blob) {
    // `idbGet` answers null for "no such record" AND for a store that would
    // not open, so this cannot claim the bytes are gone — only that they could
    // not be read. The difference matters: one needs a re-fetch over the link,
    // the other needs another try.
    const error = "could not read the downloaded bytes on this phone — try again, or fetch it once more";
    this.patch(id, { saveError: error });
    return { ok: false, error };
  }
  if (nativeSaveSupported()) {
    // Ask the folder first. A file already there needs no second copy — and
    // "no second copy" is not a nicety: MediaStore does not overwrite, it
    // renames, so every repeat of this put another `app-debug (N).apk` beside
    // the last one and spent 90 MB of bridge traffic doing it.
    const found = await findInDownloads(rec.name, rec.blob.size);
    if (found?.present) {
      this.patch(id, {
        savedTo: found.where, savedAt: Date.now(), saveError: undefined, saveVia: "device",
        savedPresent: true, savedCheckedAt: Date.now(),
      });
      return { ok: true, where: found.where, already: true };
    }
    try {
      const where = await saveToDownloads(rec.blob, rec.name);
      this.patch(id, {
        savedTo: where, savedAt: Date.now(), saveError: undefined, saveVia: "device",
        savedPresent: true, savedCheckedAt: Date.now(),
      });
      return { ok: true, where };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.patch(id, { saveError: error });
      return { ok: false, error };
    }
  }
  // Typed by NAME like every other object URL (`pullMime.ts`): a browser that ignores
  // `download` on a blob: URL would otherwise navigate to a typeless, sniffed document.
  const url = URL.createObjectURL(typedBlob([rec.blob], rec.name));
  const a = document.createElement("a");
  a.href = url;
  a.download = rec.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke late: some browsers start the write asynchronously after the click.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  // The browser owns the write from here, so this is "handed over", not
  // "landed" — say only what is actually known.
  const where = "your browser's downloads";
  this.patch(id, { savedTo: where, savedAt: Date.now(), saveError: undefined, saveVia: "browser" });
  return { ok: true, where };
}

/**
 * The same save, for a file the native engine downloaded.
 *
 * There are no bytes to hand over — they are a file in the app's own
 * directory — so this is a message, and the copy into Downloads happens
 * inside Java. The folder is asked FIRST for the reason it is asked on the
 * bridge path: MediaStore does not overwrite, it renames, so a second save of
 * a file already there makes `app-debug (6).apk` beside the five before it.
 */
export async function pullSaveNative(this: PullManager, id: string, rec: PullRecord): Promise<SaveResult> {
  const name = rec.item.name || rec.item.relPath.split("/").pop() || rec.item.relPath;
  const found = await findInDownloads(name, rec.item.size || undefined);
  if (found?.present) {
    this.patch(id, {
      savedTo: found.where, savedAt: Date.now(), saveError: undefined, saveVia: "device",
      savedPresent: true, savedCheckedAt: Date.now(),
    });
    return { ok: true, where: found.where, already: true };
  }
  try {
    await nativePublish(id);
    // The publish is done by the service, so the destination comes back the
    // way every other fact about a native transfer does: off its own row.
    //
    // **And it comes back LATER.** `publish()` posts an intent and resolves;
    // the copy into MediaStore happens on the service's worker thread. Reading
    // the row straight back therefore read it BEFORE the file had moved — so
    // every finished download reported "the file was not saved" while the file
    // was landing in Downloads a second later, and the row kept that sentence
    // for ever because a `saveError` is what stops the hand-off retrying. The
    // wait is bounded and the deadline says exactly that it is one: an answer
    // that never came is not a save that failed.
    const until = Date.now() + PUBLISH_WAIT_MS;
    for (;;) {
      // The service's own list, NOT a full `syncNative` per tick: that patches
      // every row, and a patch persists the whole map and wakes every
      // subscriber. Forty-five rows at three polls a second, while the phone
      // is busy installing an APK, is a thousand localStorage writes to learn
      // one field. The sync happens ONCE, when there is news.
      const state = await nativeList();
      // Deleted while we waited. Nothing to save and nobody to save it for —
      // "it is still on this phone" about a file somebody just removed is the
      // one sentence this must not produce.
      if (!this.records[id]) return { ok: false, error: "the download was removed while it was being saved" };
      const fresh = state.items.find((r) => r.id === id);
      if (fresh?.where || fresh?.error) {
        await this.syncNative(state);
        const after = this.records[id];
        if (after?.savedTo) return { ok: true, where: after.savedTo };
        if (after?.saveError) return { ok: false, error: after.saveError };
      }
      if (Date.now() >= until) break;
      await new Promise((r) => setTimeout(r, PUBLISH_POLL_MS));
    }
    // Not a failure — a question still open. `saveHandedAt` is what stops the
    // automatic hand-off retrying on every repaint, WITHOUT the row telling
    // anybody the save failed; the service's own next answer and `verifySaved`
    // both settle it.
    this.patch(id, { saveHandedAt: Date.now() });
    return { ok: false, error: "the phone has not said where it went yet — look in Downloads" };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    this.patch(id, { saveError: error });
    return { ok: false, error };
  }
}

/**
 * Re-ask Downloads whether a file this record claims to have saved is still
 * there, and write the answer onto the record.
 *
 * Deliberately a QUESTION and never a save: the row's own sentence is the
 * only thing that changes here. Silent about everything it cannot answer —
 * a browser, an older APK, a refused query — because `savedPresent`
 * undefined means "nobody asked" and the row then says exactly what it said
 * before this existed.
 *
 * The size comes from the record rather than the blob: reading 90 MB out of
 * IndexedDB to ask a question about a filename is the version of this that
 * makes opening the sheet expensive.
 */
export async function pullVerifySaved(this: PullManager, id: string): Promise<boolean | undefined> {
  const rec = this.records[id];
  if (!rec || rec.state !== "done" || rec.evicted) return undefined;
  if (!nativeFindSupported()) return undefined;
  const name = rec.item.name || rec.item.relPath.split("/").pop() || rec.item.relPath;
  const found = await findInDownloads(name, rec.item.size || undefined);
  if (!found) return undefined;
  this.patch(id, {
    savedPresent: found.present,
    savedCheckedAt: Date.now(),
    // A file found under a name we never recorded (the phone was reinstalled,
    // the record predates saving) is still where it is: say so — and that
    // answer RETIRES a `saveError`, because the folder holding the file is
    // the end of the argument about whether the save happened. Rows that
    // carried a save the page gave up on too early heal themselves here.
    ...(found.present && found.where
      ? {
        savedTo: found.where,
        savedAt: rec.savedAt ?? Date.now(),
        saveVia: rec.saveVia ?? "device" as const,
        saveError: undefined,
        saveHandedAt: undefined,
      }
      : {}),
  });
  return found.present;
}

/** Ask about every finished download at once — what the Downloads sheet does
 *  when it opens. Sequential on purpose: a bridge call per row, in a list
 *  that is tens long, is not worth parallelising and a burst of them on a
 *  cold WebView is how the first paint stutters. */
export async function pullVerifyAllSaved(this: PullManager): Promise<void> {
  if (!nativeFindSupported()) return;
  for (const rec of this.list()) {
    if (rec.state !== "done" || rec.evicted) continue;
    await this.verifySaved(rec.item.id);
  }
}

/** An object URL for previewing a finished download (image viewer). Caller
 *  revokes. */
export async function pullObjectUrl(this: PullManager, id: string): Promise<string | null> {
  // A native download's bytes are a file, not a blob: the URL is Capacitor's
  // own mapping of that path onto the local asset server, so a preview costs
  // no bridge traffic and no network request. Revoking it is a no-op, which
  // is why callers need no new branch.
  const local = this.records[id];
  if (local?.nativePath) {
    const url = nativeFileUrl(local.nativePath);
    if (url) return url;
  }
  const rec = await idbGet<PullBlob>("pulls", id);
  // Re-typed by NAME here too: a record stored typeless by an older build would
  // otherwise be sniffed, and a `.pdf` holding HTML would render as a page on
  // this origin (`pullMime.ts`).
  return rec?.blob ? URL.createObjectURL(typedBlob([rec.blob], rec.name)) : null;
}
