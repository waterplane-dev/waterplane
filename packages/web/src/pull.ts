/**
 * Auto-download client — the read-side twin of the send queue.
 *
 * `outbox.ts` makes text survive a dead tunnel on the way UP. This makes bytes
 * survive it on the way DOWN: the host queues "this file is worth having"
 * (host/autopull.ts), and this module fetches it in the background, keeps the
 * byte offset across a dropped link, a reload and the app being killed, and only
 * then calls it done.
 *
 * Two engines, picked per download:
 *
 *  1. **Background Fetch** (`registration.backgroundFetch`) — Chrome on Android,
 *     installed PWA, secure context. The browser owns the transfer: it keeps
 *     going with the app CLOSED, shows an OS progress notification, and retries
 *     across connectivity changes itself. This is what makes auto-download real
 *     rather than "downloads while you stare at it", and it is why no APK is
 *     needed on Android. **Never used from the native shell**, where the request
 *     is cross-origin and this engine cannot make one that works — see
 *     `startBackgroundFetch`.
 *  2. **The native engine** (`nativePull.ts` → the shell's pull service) — the Android
 *     shell only, and the ONLY engine there that survives the app being
 *     backgrounded. Chromium freezes the document 300 s after it is hidden
 *     (measured; the shell's link service carries the numbers), which stops the pump,
 *     the retry timer, the stall fuses and the reader loop below — so in the APK
 *     the transfer runs in a foreground service and this module keeps only the
 *     queue and the words.
 *  3. **Chunked Range fetch** — everywhere else (iOS/Safari has no Background
 *     Fetch). Reads the body in slices, persists the accumulated Blob plus its
 *     offset to IndexedDB as it goes, and resumes with `Range: bytes=<n>-` on the
 *     next attempt. Only runs while the page is alive, but it survives the page
 *     DYING: the offset is on disk, not in a variable.
 *
 * The offset lives WITH the bytes (one IndexedDB record) precisely so the two
 * cannot drift — a stored "received: 40 MB" against a 12 MB blob would append
 * the wrong range and produce a corrupt file that looks complete.
 *
 * The host is not told what any device already has: several phones can subscribe
 * to one host, so "done" is per-device state and lives here.
 *
 * This file is the barrel; the code is in `pull/` (docs/notes/pulllink-architecture.md).
 */
export type { LocalPull, PullRecord, PullState, SaveResult } from "./pull/pullTypes";
export { autoPull, localPullId } from "./pull/pullConsts";
export { onServiceWorkerPullMessage, pulls, setAutoPull } from "./pull/pullManager";
