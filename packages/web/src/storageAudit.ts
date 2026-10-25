/**
 * Measuring what this phone holds, and letting go of a part of it.
 *
 * The impure half of `storagePlan.ts`: that file has the rules and the words,
 * this one has the IndexedDB cursors, `navigator.storage.estimate()` and the
 * buttons' actual effects. `StorageSheet.tsx` draws the two together.
 *
 * ── Two things it deliberately does NOT do ──────────────────────────────────
 *
 *  - **It is not a second eviction policy.** Every cache below already has a
 *    bound of its own (`thumbCache.ts` 24 MB / 400 entries, `offlineCache.ts`
 *    12 transcripts and 60 tool turns, `pull.ts` 200 records and a seven-day
 *    blob eviction, `attachments.ts` 12 orphans, `dictateQueue.ts` its own
 *    hold cap). Nothing here runs on a timer, on open, or on a threshold —
 *    nothing applies itself (CLAUDE.md). It measures, and it acts on a tap.
 *  - **It does not reach into a store it does not own.** Four of these have
 *    state in memory as well as on disk, and clearing only the disk half is a
 *    lie with a delay: the thumbnail warmer would refuse to refill the cache
 *    it just emptied (`queued`), the scrollback would be re-saved from
 *    `logs` on the next beat, the dictation index would name blobs that are
 *    gone, and the transcript prefetch would think it was warm. So each owner
 *    exports its own `forget…` and this file calls it. A `idbClear("thumbs")`
 *    here would pass review and be wrong.
 *
 * ── The one measurement subtlety ────────────────────────────────────────────
 *
 * Reading a Blob out of a cursor hands back a HANDLE, not the bytes, so asking
 * 400 thumbnails and a 90 MB APK for their `.size` costs nothing. Strings are
 * counted, never re-encoded (`utf8Len`). This screen is opened exactly when the
 * phone is short of memory, and a measurement that needs a second copy of
 * everything it measures is the wrong instrument for that moment.
 */
import { forgetKept, isKeptKey } from "./attachments";
import { forgetDictations } from "./dictateQueue";
import { idbClear, idbMeasure } from "./idb";
import { forgetCacheStore } from "./offlineCache";
import { readStorageState } from "./persist";
import { pulls } from "./pull";
import { forgetScreenLogs } from "./screenlog";
import { forgetThumbs } from "./thumbCache";
import { utf8Len, type StoreUse } from "./storagePlan";

/**
 * What one stored record weighs, near enough to act on.
 *
 * Exact for the part that matters — blobs and buffers report their real size,
 * strings are counted as UTF-8 — and approximate for the scaffolding around
 * them (a number is 8, a key is its own characters). IndexedDB's per-record
 * overhead and index entries are not knowable from here at all; they land in
 * the unaccounted figure `storagePlan.ts` prints, which is where an unknown
 * belongs.
 *
 * Depth-capped because a cycle would hang the cursor, and a record nested six
 * deep is not a record this app writes.
 */
function weigh(v: unknown, depth = 0): number {
  if (v == null) return 0;
  if (typeof v === "string") return utf8Len(v);
  if (typeof v === "number") return 8;
  if (typeof v === "boolean") return 4;
  if (v instanceof Blob) return v.size;
  if (v instanceof ArrayBuffer) return v.byteLength;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (depth >= 6) return 0;
  if (Array.isArray(v)) {
    let n = 0;
    for (const e of v) n += weigh(e, depth + 1);
    return n;
  }
  if (typeof v === "object") {
    let n = 0;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) n += utf8Len(k) + weigh(val, depth + 1);
    return n;
  }
  return 0;
}

/**
 * The rows, in the order they are declared and with the words they are drawn
 * with — one table rather than a `switch` in the sheet, so a store cannot be
 * added to `idb.ts` and measured here while being described nowhere.
 *
 * `cost` is what clearing loses, and it is required. A cache saying "costs a
 * re-fetch" is a real answer; a row with no sentence at all invites the tap it
 * should be qualifying.
 */
interface RowSpec {
  id: string;
  store: string;
  label: string;
  kind: StoreUse["kind"];
  cost: string;
  /** Narrow the measurement to part of a store — see `uploads`. */
  include?: (key: string) => boolean;
  cant?: string;
}

const ROWS: readonly RowSpec[] = [
  // ── re-fetchable ─────────────────────────────────────────────────────────
  {
    id: "thumbs", store: "thumbs", label: "gallery thumbnails", kind: "cache",
    cost: "The grid re-fetches them one request at a time as you scroll; offline it draws blanks until you are back.",
  },
  {
    id: "transcripts", store: "transcripts", label: "conversation transcripts", kind: "cache",
    cost: "The reader re-reads each one from the desktop. Offline, a session you have not opened since shows nothing.",
  },
  {
    id: "tooldetail", store: "tooldetail", label: "expanded tool calls", kind: "cache",
    cost: "A tool call you had opened folds back up until the desktop is reachable.",
  },
  {
    id: "pty", store: "pty", label: "terminal tails", kind: "cache",
    cost: "A cold start with no host paints an empty terminal instead of the last screen it had.",
  },
  {
    id: "gallery", store: "gallery", label: "gallery listings", kind: "cache",
    cost: "The gallery opens on a spinner instead of the last list of files it drew.",
  },
  {
    id: "artifacttext", store: "artifacttext", label: "documents you opened", kind: "cache",
    cost: "A report you read on the train is fetched again next time — and not readable at all with the tunnel down.",
  },
  {
    id: "tree", store: "tree", label: "folder listings", kind: "cache",
    cost: "The file browser asks the desktop again for every folder you walk into.",
  },
  {
    id: "ctxseries", store: "ctxseries", label: "context-window history", kind: "cache",
    cost: "The context graph re-reads its series; offline it has no curve to draw.",
  },
  {
    id: "tokenstats", store: "tokenstats", label: "token statistics", kind: "cache",
    cost: "One re-read, which is expensive for the DESKTOP to rebuild — the screen shows nothing until it answers.",
  },
  {
    id: "extassets", store: "extassets", label: "extension downloads", kind: "cache",
    cost: "An extension's engine fetched from the desktop — the text-in-marks reader is about 8 MB. Re-downloaded when it is switched on again.",
    // A sentence, not a button here: deleting under a switched-ON extension would leave it saying
    // "Ready" over nothing. Its own row offers the delete once it is off.
    cant: "switch the extension off in Settings › Tools & diagnostics › plugins — its row there then offers to delete the download.",
  },
  // ── the only copy on this phone ──────────────────────────────────────────
  {
    id: "screenlog", store: "screenlog", label: "terminal scrollback", kind: "keep",
    cost: "The lines that scrolled off the TUI are not on the wire — the desktop cannot send them again. Panning up stops working for these sessions.",
  },
  {
    id: "dictations", store: "dictations", label: "recordings not yet read", kind: "keep",
    cost: "Audio the desktop has not transcribed yet. Nobody can re-say a sentence; a clip being sent right now is left alone.",
  },
  {
    id: "keptuploads", store: "uploads", label: "photos from failed sends", kind: "keep",
    include: isKeptKey,
    cost: "Pictures held so you can re-attach them after a send died. They exist here and nowhere else.",
  },
  {
    id: "queueduploads", store: "uploads", label: "photos waiting to send", kind: "keep",
    include: (k) => !isKeptKey(k),
    cost: "The pictures of messages still in the send queue.",
    // Not a dimmed control — a sentence saying where the verb IS
    // (`Unavailable.tsx`). Deleting these bytes from here would leave a queued
    // message that sends its words without the photo they are about, and the
    // one screen where that decision can be made with the words in front of
    // you is the queue.
    cant: "these belong to messages still queued — remove the message on the queue screen and its photo goes with it.",
  },
];

/** A download's bytes, held on this phone, as a row of its own — see
 *  `measureStorage`. */
export interface DownloadUse {
  /** Finished downloads whose bytes are still here AND have been saved out to
   *  the phone's own storage: dropping these loses nothing you kept. */
  savedIds: string[];
  savedBytes: number;
  /** Finished downloads still here that were never saved out. Re-fetchable
   *  while the desktop still has the build — which it prunes (`artifacts.ts`
   *  keeps 3), so this is the row that says "or get it again, probably". */
  unsavedIds: string[];
  unsavedBytes: number;
  /** Of the above, the ones the Android shell holds as FILES rather than in
   *  IndexedDB — invisible to `navigator.storage.estimate()`. */
  nativeCount: number;
  nativeBytes: number;
}

export interface StorageAudit {
  rows: StoreUse[];
  downloads: DownloadUse;
  /** Sum of every row's bytes, or null when anything was unmeasurable. */
  named: number | null;
  estimate?: number;
  quota?: number;
}

/** What the phone is holding right now. One pass per store, in parallel. */
export async function measureStorage(): Promise<StorageAudit> {
  const [state, ...measured] = await Promise.all([
    readStorageState(),
    ...ROWS.map((r) => idbMeasure(r.store, weigh, r.include)),
  ]);
  const rows: StoreUse[] = ROWS.map((r, i) => {
    const m = measured[i] as { count: number; bytes: number } | null;
    return {
      id: r.id,
      label: r.label,
      kind: r.kind,
      // Null bytes AND a zero count is the unmeasurable case — a store the
      // browser refused. The screen says "size unknown" for it rather than
      // claiming it is empty, which is the difference between an honest
      // reading and a wrong one (CLAUDE.md).
      count: m?.count ?? 0,
      bytes: m ? m.bytes : null,
      cost: r.cost,
      cant: r.cant,
    };
  });

  const downloads = measureDownloads();
  // Downloads count toward what this screen has NAMED, or the total under-reports
  // by the largest thing on the phone — but only the ones the browser is
  // actually holding. A native download's bytes are a FILE: they are not in
  // `estimate()`, so adding them to `named` would manufacture an "unaccounted"
  // gap out of bytes that were never in the browser's figure to begin with
  // (`nativeNoteText` is where those are said instead).
  const idbDownloads = downloads.savedBytes + downloads.unsavedBytes - downloads.nativeBytes;
  const named = rows.some((r) => r.bytes == null)
    ? null
    : rows.reduce((n, r) => n + (r.bytes ?? 0), 0) + Math.max(0, idbDownloads);

  return { rows, downloads, named, estimate: state.usage, quota: state.quota };
}

/**
 * Downloads are read off `pull.ts`' own records rather than by measuring the
 * `pulls` store, for two reasons that both matter: the native engine keeps its
 * bytes as a FILE (so a measurement of IndexedDB would report 0 for the
 * biggest thing on the phone), and the record is where "was this saved out?"
 * lives — which is the fact that splits a safe drop from a lossy one.
 */
function measureDownloads(): DownloadUse {
  const out: DownloadUse = { savedIds: [], savedBytes: 0, unsavedIds: [], unsavedBytes: 0, nativeCount: 0, nativeBytes: 0 };
  for (const r of pulls.list()) {
    // Dropped after the save: the bytes are Downloads', not this app's.
    if (r.state !== "done" || r.evicted || r.droppedAt) continue;
    const bytes = r.received || r.item.size || 0;
    if (!bytes) continue;
    if (r.nativePath) { out.nativeCount++; out.nativeBytes += bytes; }
    if (r.savedAt) { out.savedIds.push(r.item.id); out.savedBytes += bytes; }
    else { out.unsavedIds.push(r.item.id); out.unsavedBytes += bytes; }
  }
  return out;
}

/**
 * Empty one row, through its owner.
 *
 * Answers what it actually removed, including the `keep` case that refuses
 * part of the job: a dictation being transcribed right now stays, and the
 * caller says so rather than reporting a clear that did not happen.
 */
export async function clearRow(row: StoreUse): Promise<{ ok: boolean; note?: string }> {
  switch (row.id) {
    case "thumbs": return { ok: await forgetThumbs() };
    case "screenlog": return { ok: await forgetScreenLogs() };
    case "keptuploads": return { ok: await forgetKept() };
    case "dictations": {
      const r = await forgetDictations();
      return { ok: true, note: r.kept ? `${r.kept} kept — it is being transcribed right now.` : undefined };
    }
    case "extassets":
    case "queueduploads":
      // Has a `cant`; the sheet draws no button for it. Refused here too, so a
      // second caller cannot route around the sentence.
      return { ok: false, note: row.cant };
    case "transcripts": case "tooldetail": case "gallery":
    case "artifacttext": case "tree": case "ctxseries": case "tokenstats":
      return { ok: await forgetCacheStore(row.id) };
    case "pty": return { ok: await idbClear("pty") };
    default: return { ok: false, note: "this screen does not know how to clear that." };
  }
}

/** Drop the bytes of exactly these downloads — ids, never a rule (`pull.ts`
 *  `dropBytes`). The records stay, so every one is still a tap away. */
export async function dropDownloads(ids: string[]): Promise<{ count: number; bytes: number }> {
  return pulls.dropBytes(ids);
}
