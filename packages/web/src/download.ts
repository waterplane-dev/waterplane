/**
 * **Downloading a file — the ONE way, everywhere.**
 *
 * There used to be two, which is why the buttons behaved differently depending
 * on which screen you were on and which shell you were in:
 *
 *  1. a hidden `<a download href="…&download=1">` click (the gallery's
 *     *download*, a tapped notification, a build artifact, Activity's *download
 *     what it made*). In a browser that is the browser's own download; **in the
 *     Capacitor WebView it does nothing at all** — no listener, no error, no
 *     file (`nativeSave.ts` documents the same hole from the other side). So the
 *     most-used button in the app was silently dead in the APK, and where it did
 *     work the file landed somewhere this app could not name, resumed nothing
 *     when the link dropped, and appeared in no list.
 *  2. the pull queue (`pull.ts`) behind the gallery's *to phone*: resumable,
 *     visible, saved through the native bridge — and reachable from exactly one
 *     screen, under a name nobody reads as "download".
 *
 * Now every download button in the app calls `startDownload()`, so all of them:
 *
 *  - **go through the queue**, i.e. resume from the byte they got to, survive a
 *    reload, and keep going with the app closed where Background Fetch exists;
 *  - **land in the same place** — the phone's Downloads via `ShellSavePlugin` in
 *    the APK, the browser's downloads in a tab — with the row saying WHICH, read
 *    back from MediaStore rather than assumed;
 *  - **show up in one list**, the Downloads sheet, whichever button started them.
 *
 * Two rules worth keeping:
 *
 *  - **A tap is not automatic work.** The record is `local` (see `pull.ts`): it
 *    needs no WebSocket, is not queued onto every other phone on this host, is
 *    not withdrawn by a host sync, and keeps being retried with the auto-download
 *    switch off.
 *  - **One tap, one file.** The hand-off to the device happens by itself when the
 *    transfer finishes (`autoSave`), because "download" that leaves the bytes in
 *    IndexedDB behind a second button called *save* is the two-step nobody
 *    finished. The second button stays for the case where the automatic one
 *    could not run — a browser may refuse a download it cannot tie to a gesture,
 *    and it is honest to say so rather than to claim the file is on the phone.
 */
import { pulls, type LocalPull, type PullRecord } from "./pull";
import { artifactMark, markArtifactDownloaded } from "./artifactMarks";
import { autoSaveEligible, downloadAction } from "./downloadState";
import { nativeSaveSupported } from "./nativeSave";
import { LS, lsGet, lsSet } from "./storage";
import { showToast } from "./toast";

/**
 * Put every finished download into the phone's Downloads, tap or no tap.
 *
 * On by default, and only ever true where there is a folder to write to: in a
 * browser the hand-off is an anchor click the browser may refuse unless it can
 * tie it to a gesture, so an automatic one is a download that silently does
 * not happen. In the APK it is the whole point — a file that finished
 * downloading and then sat in IndexedDB behind a save button is a file the
 * phone does not have.
 *
 * Device-local (`storage.ts` says why it is not synced).
 */
export function autoSaveOut(): boolean {
  return nativeSaveSupported() && lsGet(LS.pullAutoSave) !== "0";
}

/** The stored preference itself — what the switch renders, which is not the
 *  same question as `autoSaveOut()`: a browser must still show what it is set
 *  to rather than a switch that reads "off" and cannot be turned on. */
export function autoSaveOutPref(): boolean {
  return lsGet(LS.pullAutoSave) !== "0";
}

export function setAutoSaveOut(on: boolean): void {
  lsSet(LS.pullAutoSave, on ? "1" : "0");
  // Turning it on covers what already finished while it was off, without the
  // 28 taps this setting exists to replace.
  if (on) for (const r of pulls.list()) if (autoSaveEligible(r, true)) void saveNow(r.item.id, { silent: true });
}

/** Ask App to open the Downloads sheet. Mounted once (App listens); every
 *  sentence about "see Downloads" can then be a tap as well as a word. */
export const OPEN_DOWNLOADS_EVENT = "app:open-downloads";

/**
 * How to name a repo, given the id a download target carries.
 *
 * Every call site knows the `repoId` (it is in the URL) and almost none knows
 * the repo's NAME — a `BuildArtifact` carries none, a notification carries
 * none, a file reference in a transcript carries none — so a Downloads row read
 * `" · 23 MB"` with a blank repo for nearly every button in the app. Rather
 * than making eight call sites remember, App registers the lookup once and this
 * fills it in. Unset ⇒ rows simply lack the name, exactly as before.
 */
let namer: ((repoId: string) => { repoName?: string; repoDir?: string } | undefined) | null = null;

export function setRepoNamer(fn: (repoId: string) => { repoName?: string; repoDir?: string } | undefined): void {
  namer = fn;
}

/** Ids whose hand-off to the phone is in flight. A repaint, a second tap and
 *  the automatic save all pass through here, so the bytes cross the bridge
 *  once. */
const saving = new Set<string>();

export function openDownloads(): void {
  // No `track` here: App counts every overlay open in one effect, and counting
  // it again would make this route look twice as used as it is.
  dispatchEvent(new CustomEvent(OPEN_DOWNLOADS_EVENT));
}

/**
 * Fetch a repo artifact to this device, and hand it to the device when it
 * lands. Idempotent per file: tapping twice resumes rather than duplicating.
 */
export function startDownload(t: LocalPull, opts: { silent?: boolean } = {}): string {
  const name = t.name || t.relPath.split("/").pop() || t.relPath;
  const known = t.repoName && t.repoDir ? undefined : namer?.(t.repoId);
  const existing = pulls.findFor(t.repoId, t.relPath, t.mtime);
  const id = pulls.addLocal({
    ...t, name,
    repoName: t.repoName || known?.repoName,
    repoDir: t.repoDir || known?.repoDir,
  }, { autoSave: true });
  if (opts.silent) return id;
  const rec = pulls.get(id);
  if (rec?.state === "done" && !rec.evicted) {
    // Already on the device: the tap means "put it where I can find it". (A
    // record that has never been saved is handed over by `installDownloads`
    // instead; `saveNow` de-duplicates the two, so neither has to know.)
    void saveNow(id);
    return id;
  }
  showToast(
    existing && existing.received > 0
      ? `resuming ${name} — see Downloads`
      : `downloading ${name} — it saves itself when it lands`,
  );
  return id;
}

/**
 * Hand a finished download to the device now, and say where it went.
 *
 * The one place that words this outcome, so a toast fired by a tap and one
 * fired by the automatic hand-off cannot disagree — and the one place that
 * de-duplicates it: a tap arriving while the automatic save of the same file is
 * still crossing the bridge must not write those megabytes into Downloads
 * twice.
 */
export async function saveNow(id: string, opts: { silent?: boolean } = {}): Promise<void> {
  const rec = pulls.get(id);
  const name = rec?.item.name ?? "the file";
  if (saving.has(id)) {
    // A tap on a save already crossing the bridge is worth a word; the automatic
    // watcher below re-enters here on EVERY queue repaint — once every flush of
    // whatever else is downloading — and wording that would be one toast every
    // 1.5 s for the length of a 90 MB save.
    if (!opts.silent) showToast(`saving ${name}…`);
    return;
  }
  saving.add(id);
  try {
    const r = await pulls.save(id);
    // The device path is read back from MediaStore, so it can name where the
    // file now lives. The browser path only HANDED it over — a download it
    // could not tie to a gesture is refused silently — so it says just that.
    const via = pulls.get(id)?.saveVia;
    showToast(r.ok
      ? (r.already ? `already in ${r.where}`
        : via === "browser" ? `handed to ${r.where} — ${name}` : `saved to ${r.where}`)
      : `could not save ${name} — ${r.error}. It is still on this phone; open Downloads to try again`);
  } finally {
    saving.delete(id);
  }
}

/** Re-exported so a screen asking what a button should SAY needs one import,
 *  not two. The words and the tap rule live in `downloadState.ts` (pure,
 *  node-tested); the doing lives here. */
export { downloadStatus } from "./downloadState";

/** Act on a tap on a download button: the pure rule decides, this performs it. */
export function downloadTap(t: LocalPull, rec: PullRecord | undefined): void {
  switch (downloadAction(rec)) {
    case "save": void saveNow(rec!.item.id); return;
    case "open": openDownloads(); return;
    default: startDownload(t);
  }
}

/**
 * Watch for downloads a person asked for reaching `done`, and put them on the
 * device without a second tap.
 *
 * It lives here rather than in `pull.ts` because it is a POLICY about what a
 * button promised, not part of transferring bytes: the host's own auto-pull
 * rules deliberately do not set `autoSave`, since nothing was promised to
 * anybody and a phone that saves an APK into Downloads unasked is a surprise.
 *
 * Installed once from `main.tsx`, so it also covers the case the whole feature
 * exists for: the transfer finished while the app was closed, and the flag is on
 * the record, on disk, waiting for the next launch.
 */
export function installDownloads(): () => void {
  return pulls.subscribe((records) => {
    for (const r of records) {
      // The gallery's read/download mark, set where it is TRUE — when the bytes
      // are here. It used to be written on the tap, so a transfer that failed
      // left the grid claiming the file had been downloaded. (The mark outlives
      // the queue record, which is the only reason it still exists next to the
      // pull badge.)
      // Guarded on the mark itself rather than on a "seen it this session" set:
      // `artifactMark` reads the in-memory map and writes nothing, so the
      // watcher — which runs on every queue repaint, i.e. once per flush of
      // whatever else is downloading — costs a lookup instead of a
      // read-modify-write of a localStorage blob. A record with no mtime is
      // skipped: a mark keyed to 0 can never match a real grid row.
      if (r.state === "done" && !r.evicted && r.item.mtime
        && artifactMark(r.item.repoId, r.item.relPath, r.item.mtime) !== "downloaded") {
        markArtifactDownloaded(r.item.repoId, r.item.relPath, r.item.mtime);
      }
      // Who gets handed over is one rule (`autoSaveEligible`, node-tested): a
      // tap promised it, or the preference says every finished download goes to
      // the folder. It also holds the "already handed over / already failed"
      // refusals — a save that keeps re-trying itself on every repaint is how
      // one refusal becomes a toast loop nobody can read.
      if (!autoSaveEligible(r, autoSaveOut())) continue;
      void saveNow(r.item.id, { silent: true });
    }
  });
}
