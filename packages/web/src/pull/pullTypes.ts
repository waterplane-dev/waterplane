import type { PullItem } from "@waterplane/shared";

export type PullState = "queued" | "downloading" | "paused" | "done" | "failed";

export interface PullRecord {
  item: PullItem;
  state: PullState;
  /** Bytes already on disk (IndexedDB), i.e. where a resume starts. */
  received: number;
  attempts: number;
  /** Last failure, shown in the sheet — a silent "failed" is unactionable. */
  error?: string;
  engine?: "bgfetch" | "range" | "native";
  /**
   * The native engine holds this row: it is in the shell pull service's own queue,
   * running or backing off.
   *
   * The pump must not hand it over a second time — the service's enqueue is
   * idempotent, but a re-hand resets the give-up count, so a row backing off
   * would be forgiven its attempts every heartbeat and could never fail. It is
   * cleared when the service gives up, when the service no longer holds the row
   * at all, and by a tap (`retry`), which is the one thing that SHOULD re-hand
   * it over.
   */
  nativeOwned?: boolean;
  /** Where the finished file is INSIDE the app, when the native engine fetched
   *  it. Those bytes are never in IndexedDB — they are a file, which is what
   *  makes a 90 MB download cost nothing to keep and nothing to save out. A
   *  preview builds an `<img src>` from it (`nativeFileUrl`). */
  nativePath?: string;
  updatedAt: number;
  /** Measured throughput of the transfer in flight (bytes/s, EWMA). A percent
   *  with no rate can't answer "is this moving?", which is the actual question
   *  on a bad link. */
  rate?: number;
  /** When bytes last arrived. A stalled transfer looks exactly like a slow one
   *  until you know this. */
  lastProgressAt?: number;
  /** When the automatic retry is due, so the row can count it down instead of
   *  sitting still with no explanation. */
  nextRetryAt?: number;
  /** Bytes actually pulled over the wire for this item across every attempt —
   *  what resuming saved is otherwise invisible. */
  wireBytes?: number;
  /** A finished download whose bytes were evicted after KEEP_DONE_MS. The record
   *  stays `done` (it WAS downloaded); re-fetching is a tap, never automatic. */
  evicted?: boolean;
  /**
   * What a downloaded APK says it is, and how installing it went — carried
   * straight off the native row, the way `savedTo` is. The decisions are
   * `installPolicy.ts`'s; this file only ferries the facts.
   */
  pkg?: string;
  pkgLabel?: string;
  pkgVersion?: string;
  install?: "" | "queued" | "installing" | "asked" | "installed" | "failed";
  installError?: string;
  /** When the install reached its outcome, by the PHONE's clock. Absent on a
   *  shell older than the field — the desktop's log then says "reported", which
   *  is a claim about the log rather than a wrong claim about the install. */
  installedAt?: number;
  /** Did it install itself (allow-listed, at the end of a download), or did
   *  somebody tap? Recorded at the start of the install: the status receiver is
   *  woken long afterwards and cannot tell. **Absent where the shell never
   *  recorded it** — `false` is the positive claim that a person tapped. */
  installAuto?: boolean;
  /** "Later" on the shell's ready-to-install notification: when it returns. */
  installSnoozedUntil?: number;
  /**
   * The bytes were handed to the phone's own Downloads and it has not said
   * where they went yet.
   *
   * A THIRD state, because the two that existed could each only lie about this
   * one. `savedTo` claims a location nobody has been given; `saveError` is read
   * by every button in the app as *the save failed* — and the wait it ends is
   * BOUNDED, so an answer that did not arrive inside it is not a failure, it is
   * an answer that did not arrive. What it has in common with both is that the
   * automatic hand-off must not try again on the next repaint.
   */
  saveHandedAt?: number;
  /** The host's validator when the transfer started. A changed ETag means the
   *  file was rewritten under us and the partial bytes are garbage. */
  etag?: string;
  /** Background Fetch already failed this item once, so never hand it that
   *  engine again — see `startBackgroundFetch`. The browser reports "failure"
   *  with no status code, so the range engine is the only one that can say WHY,
   *  and a silent re-registration loop is what this flag exists to stop. */
  bgBlocked?: boolean;
  /** Where the last successful save put the file, e.g. "Downloads/app.apk".
   *  A save that does not say where it went is barely a save: the whole reason
   *  this feature exists is that a tap produced a file nobody could find. */
  savedTo?: string;
  savedAt?: number;
  /** HOW it was handed over, because the two are different claims. `device`
   *  means a file exists where a file manager can see it, read back from
   *  MediaStore. `browser` means an anchor was clicked and the browser took it
   *  from there — which it may also have refused (a download it cannot tie to a
   *  gesture is blocked silently), so the row must not say the file landed. */
  saveVia?: "device" | "browser";
  /** Why the last save failed. Sits on the row for the same reason `error` does. */
  saveError?: string;
  /**
   * Is the saved file still IN Downloads — asked of the folder, not remembered
   * from the save.
   *
   * `savedTo` is a record of something that happened once; it went on saying
   * "saved to Downloads/app-debug (5).apk" after the file was deleted, and the
   * only offer beside it was to save a sixth copy. This is the answer to the
   * question the row was actually asking. `undefined` = nobody could ask (a
   * browser, or an APK older than the plugin's `find`), which is not the same
   * as `false` and must never be worded as one.
   */
  savedPresent?: boolean;
  /** When `savedPresent` was last read off the folder. */
  savedCheckedAt?: number;
  /**
   * This device asked for this file — it is not in the host's queue.
   *
   * Every download button in the app goes through `download.ts`, which adds a
   * record here rather than sending `pull.add`: a tap must not need a live
   * WebSocket (the bytes come over plain HTTP), must not queue the same file on
   * every other phone attached to this host, and must survive `sync()`, which
   * deletes records the host's queue does not name. A local record is the one
   * kind `sync()` never touches.
   */
  local?: boolean;
  /** Hand the bytes to the device the moment the transfer finishes, without a
   *  second tap. Set for every download a person asked for; the host's own
   *  auto-pull rules leave it off, because nobody is there to be handed a file. */
  autoSave?: boolean;
}

/** What a download button knows about the file it is asking for. `size` and
 *  `mtime` are optional because not every call site has them (a notification
 *  carries neither); they only ever improve the row's labels and its identity. */
export interface LocalPull {
  repoId: string;
  relPath: string;
  name?: string;
  repoDir?: string;
  repoName?: string;
  size?: number;
  mtime?: number;
}

/** What a save attempt did, for the caller to put in front of the user. */
export interface SaveResult {
  ok: boolean;
  /** Human-readable destination on success. */
  where?: string;
  error?: string;
  /** The file was already in Downloads and nothing was written. A success, and
   *  a different sentence: "saved" would claim a copy that was not made. */
  already?: boolean;
}

/** One stored artifact: the (possibly partial) bytes plus how many there are. */
export interface PullBlob {
  id: string;
  blob: Blob;
  received: number;
  total: number;
  name: string;
}

export type Listener = (records: PullRecord[]) => void;
