/**
 * **The download that keeps going when you switch apps** — the Android-shell
 * half.
 *
 * `pull.ts`'s range engine is a complete, resumable downloader, and in the APK
 * it stopped dead every time the app went to the background. The reason is
 * measured and written down in `ShellLinkService`: the foreground service keeps
 * the app's PROCESS out of Android's freezer, but **Chromium freezes the
 * DOCUMENT on its own, 300 s after `visibilitychange`, to the second** — and the
 * pump's interval, the retry timer, the two stall fuses and the `fetch` reader
 * loop are all inside that document. Five minutes in a pocket and a 90 MB APK
 * sits at whatever percent it reached until somebody looks at the screen.
 *
 * So in the shell the transfer runs in `ShellPullService` instead: it holds the
 * connection, writes the bytes, resumes from the offset and publishes the
 * finished file into Downloads itself. This module is how the page asks, and
 * `pull.ts` keeps every decision it always made — what to fetch, in what order,
 * what a row says, when to stop trying.
 *
 * Two rules to keep:
 *
 *  - **The LIST is the truth; `pullChanged` is a courtesy.** A frozen document
 *    runs no tasks, so an event fired at a backgrounded page is dropped on the
 *    floor. Everything that must be known is re-read with `nativeList()` on
 *    every wake, and that read works with the service stopped — which is its
 *    normal state, since it stops itself the moment the queue drains.
 *  - **The bytes never cross the bridge.** They land in the app's own
 *    directory; a preview is an `<img src>` built with `Capacitor.convertFileSrc`
 *    and the save into Downloads is a file copy inside Java. Handing 90 MB over
 *    the bridge as base64 is what `nativeSave.ts` has to do for bytes that are
 *    already in IndexedDB, and the whole reason it is worth not putting them
 *    there.
 *
 * As with `nativeSave.ts` and `hostUrl.ts`, the plugin is reached off the global
 * Capacitor injects rather than an npm import: no native-shell dependency enters
 * the bundle every browser downloads.
 */
import type { PullItem } from "@waterplane/shared";
import { nativePlugin } from "./shellBridge";
import { isNativeShell } from "./hostUrl";
import { isDemo } from "./demo/mode";

/** One row of the service's own queue. The vocabulary is deliberately the same
 *  as `PullRecord`'s, so mapping one onto the other is a copy and not a
 *  translation nobody can check. */
export interface NativePullRow {
  id: string;
  url: string;
  name: string;
  mime: string;
  size: number;
  received: number;
  etag: string;
  autoSave: boolean;
  state: "queued" | "downloading" | "paused" | "done" | "failed";
  error: string;
  /** "Downloads/app-debug.apk" once the file has been published there. */
  where: string;
  attempts: number;
  /** When the service's own backoff lets this row run again, 0 when now. */
  nextAt: number;
  updatedAt: number;
  /** Absolute path of the finished file inside the app. Only on `done` rows. */
  path?: string;
  /** What a finished APK says it IS, read off the archive — three repos on this
   *  desktop all build `app-debug.apk`, so the name says nothing. Empty where
   *  the file is not an app, or could not be read: absent, never a guess. */
  pkg?: string;
  pkgLabel?: string;
  pkgVersion?: string;
  /** How installing it went. `asked` is the system installer waiting for a tap
   *  — never a failure (`installPolicy.ts`). */
  install?: "" | "queued" | "installing" | "asked" | "installed" | "failed";
  installError?: string;
  /** When the install reached its outcome, by the PHONE's clock. Absent on a
   *  shell older than the field — the desktop's log then says "reported", which
   *  is a claim about the log rather than a wrong claim about the install. */
  installedAt?: number;
  /** Did it install itself (allow-listed, at the end of a download), or did
   *  somebody tap? Recorded at the start of the install: the status receiver is
   *  woken long afterwards and cannot tell. */
  installAuto?: boolean;
  /** `link` when the shell's link service queued this row itself, off a
   *  `pull.new` this frozen page never saw — and then `item` is the host's
   *  own record, for the page to ADOPT rather than discard as an orphan.
   *  Cleared by the first `enqueue` from here. Absent on an older shell. */
  origin?: string;
  item?: PullItem;
  /** "Later" on the ready-to-install notification. Absent when not put off. */
  installSnoozedUntil?: number;
}

interface Handle { remove(): void }

interface NativePullPlugin {
  enqueue(o: {
    id: string; url: string; name: string; mime?: string;
    size?: number; etag?: string; autoSave?: boolean;
  }): Promise<{ items: NativePullRow[]; running: boolean }>;
  cancel(o: { id: string }): Promise<void>;
  discard(o: { id: string }): Promise<void>;
  publish(o: { id: string }): Promise<void>;
  list(): Promise<{ items: NativePullRow[]; running: boolean }>;
  /** Absent on a shell older than the link service's own auto-download. */
  setAuto?(o: { on: boolean }): Promise<void>;
  /**
   * **Synchronous here, a promise under `@capacitor/core`.** The shell's
   * injected bridge (`JSExport.getPluginJS`) gives every plugin an
   * `addListener` that returns `{ remove }` outright, where the npm package
   * returns a promise for it — and this app reaches plugins off the injected
   * global on purpose (`hostUrl.ts` says why). Typed as both, because calling
   * `.then` on the object the shell actually returns is a TypeError, and the
   * failure would be a listener that never registers.
   */
  addListener(
    event: "pullChanged",
    cb: (data: { items: NativePullRow[] }) => void,
  ): Handle | Promise<Handle>;
}

type Cap = {
  Plugins?: Record<string, unknown>;
  convertFileSrc?: (path: string) => string;
};

function cap(): Cap | undefined {
  return (globalThis as unknown as { Capacitor?: Cap }).Capacitor;
}

function plugin(): NativePullPlugin | null {
  // The demo starts no native download service: the Java side would dial a
  // desktop directly, around the demo transport (demo-mode-plan.md §2).
  if (isDemo()) return null;
  const p = nativePlugin<NativePullPlugin>("Pull");
  return p && typeof p.enqueue === "function" ? p : null;
}

/**
 * Can this device download without the page?
 *
 * False in every browser — there the range engine is right and already works —
 * and false in an APK older than this plugin, which is a real case: the UI
 * updates over the air while the binary does not, so a phone runs a bundle
 * whose shell predates any given plugin for as long as it likes. Unknown ⇒ the
 * page downloads exactly as it did before.
 */
export function nativePullSupported(): boolean {
  return isNativeShell() && plugin() !== null;
}

/** What the service answers with: its whole queue, and whether it is up.
 *  `running` is not decoration — a row it holds as `queued` while it is STOPPED
 *  is a row nothing will ever start, which is the one state the page has to be
 *  able to take back. See `pull.ts`'s `syncNative`. */
export interface NativePullState {
  items: NativePullRow[];
  running: boolean;
}

/** Fetch this file in the background until it is here. Idempotent by id. */
export async function nativeEnqueue(o: {
  id: string; url: string; name: string; mime?: string;
  size?: number; etag?: string; autoSave?: boolean;
}): Promise<NativePullState | null> {
  const p = plugin();
  if (!p) return null;
  const r = await p.enqueue(o);
  return { items: r?.items ?? [], running: !!r?.running };
}

/** Stop the transfer, keep the bytes — it resumes from the offset. */
export async function nativeCancel(id: string): Promise<void> {
  try { await plugin()?.cancel({ id }); } catch { /* the row's own state says what happened */ }
}

/** Forget the row and delete whatever of the file is on the phone. */
export async function nativeDiscard(id: string): Promise<void> {
  try { await plugin()?.discard({ id }); } catch { /* nothing to clean up we can reach */ }
}

/**
 * Put a finished download into Downloads now.
 *
 * The service does this by itself for a file a person tapped; this is the
 * button for the ones the host's own auto-pull rules fetched, where nothing was
 * promised to anybody. Below API 29 it is also where the storage permission is
 * asked for — a service cannot show a dialog.
 */
export async function nativePublish(id: string): Promise<void> {
  const p = plugin();
  if (!p) throw new Error("no native download engine on this device");
  await p.publish({ id });
}

/** Every row the service holds. Answers with the service stopped — which is
 *  its normal state, since it stops itself when the queue drains. */
/** Mirror the auto-download switch into the shell, where the link service
 *  reads it before queueing a `pull.new` the frozen page could not. */
export async function nativeSetAuto(on: boolean): Promise<void> {
  const p = plugin();
  if (!p || typeof p.setAuto !== "function") return;
  try { await p.setAuto({ on }); } catch { /* the shell keeps its default: on */ }
}

export async function nativeList(): Promise<NativePullState> {
  const p = plugin();
  if (!p) return { items: [], running: false };
  try {
    const r = await p.list();
    return { items: r?.items ?? [], running: !!r?.running };
  } catch {
    return { items: [], running: false };
  }
}

/** Live changes while the page is awake. Returns an unsubscribe. */
export function onNativePullChange(cb: (rows: NativePullRow[]) => void): () => void {
  const p = plugin();
  if (!p) return () => undefined;
  let handle: Handle | null = null;
  let dead = false;
  const take = (h: Handle) => { if (dead) h.remove(); else handle = h; };
  try {
    const res = p.addListener("pullChanged", (data) => cb(data?.items ?? []));
    if (res && typeof (res as Promise<Handle>).then === "function") {
      void (res as Promise<Handle>).then(take).catch(() => undefined);
    } else {
      take(res as Handle);
    }
  } catch {
    // No listener. The list re-read is the source of truth anyway, so this
    // degrades to "progress moves on the heartbeat" rather than to nothing.
  }
  return () => {
    dead = true;
    try { handle?.remove(); } catch { /* already gone with the bridge */ }
  };
}

/**
 * A URL the WebView can load for a file the service downloaded.
 *
 * `convertFileSrc` maps an app-private path onto Capacitor's local asset
 * server, which is what lets an image be previewed with no bytes crossing the
 * bridge and no request going near the network. Null when the shell cannot map
 * it — the caller then falls back to the host's own copy, which is what every
 * screen did before any of this existed.
 */
export function nativeFileUrl(path: string | undefined): string | null {
  if (!path) return null;
  const c = cap();
  try {
    return typeof c?.convertFileSrc === "function" ? c.convertFileSrc(path) : null;
  } catch {
    return null;
  }
}
