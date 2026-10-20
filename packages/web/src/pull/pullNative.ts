import { idbDel } from "../idb";
import { nativeDiscard, nativeEnqueue, nativeList, nativePullSupported, type NativePullRow, type NativePullState } from "../nativePull";
import type { PullRecord } from "./pullTypes";
import { NATIVE_SYNC_MS, artifactUrl } from "./pullConsts";
import type { PullManager } from "./pullManager";

// ── engine 0: the native service ──────────────────────────────────
/**
 * Hand the transfer to the shell's pull service. Returns true when it took it.
 *
 * **This is the only engine in the APK that finishes a download the user is
 * not watching.** Everything this class does to move bytes lives in the
 * document, and Chromium freezes a hidden document 300 s in — so with the
 * range engine the transfer stopped when the user switched apps, at whatever
 * percent it had reached, silently, until the app was foregrounded again.
 *
 * The slot is freed the moment the service accepts, the same way Background
 * Fetch frees it: the service runs one transfer at a time itself, so handing
 * it the whole queue starts nothing in parallel — and holding `active` for a
 * transfer this page is not making would stop the queue dead the moment the
 * page went away, which is the bug.
 */
export async function pullStartNative(this: PullManager, rec: PullRecord): Promise<boolean> {
  if (!nativePullSupported()) return false;
  try {
    const answer = await nativeEnqueue({
      id: rec.item.id,
      url: artifactUrl(rec.item),
      name: rec.item.name || rec.item.relPath.split("/").pop() || rec.item.relPath,
      size: rec.item.size || undefined,
      etag: rec.etag,
      // What a tap promised (`download.ts`), which is what decides whether the
      // finished file is published into Downloads without a second tap. The
      // host's own auto-pull rules leave it off — nobody is there to be handed
      // a file.
      autoSave: !!rec.autoSave,
    });
    // The service answers with its whole queue, so the row's state comes from
    // the thing that owns it rather than from a guess made here — which is
    // the same rule `syncNative` states, applied at the one moment the answer
    // is already in hand.
    this.patch(rec.item.id, { engine: "native", nativeOwned: true, lastProgressAt: Date.now() });
    // A partial the RANGE engine collected cannot be handed over — the
    // service resumes from its own file's length and has never seen these
    // bytes. They are dead the moment the row moves engines (which happens
    // once, on the update that brought this engine to a phone mid-transfer),
    // and nothing else enumerates the store, so a blob left here is megabytes
    // with nothing pointing at them.
    if (rec.received > 0 && !rec.nativePath) void idbDel("pulls", rec.item.id);
    if (answer) await this.syncNative(answer);
    return true;
  } catch (e) {
    // A refusal here is never fatal: the range engine is a complete
    // implementation and the row keeps its own words. The commonest cause is
    // Android 15 refusing a background start of a `dataSync` service, which
    // is exactly the case the range engine can still limp through.
    this.patch(rec.item.id, { error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/**
 * Read the service's queue and write it onto the records.
 *
 * **The pushed `pullChanged` event is a courtesy; this is the truth.** A
 * frozen document runs no tasks, so every event fired while the app was in
 * the background was dropped — which is precisely the period the native
 * engine exists to cover. So the page asks on every wake instead, and the
 * answer is authoritative for anything the service owns.
 */
export async function pullSyncNative(this: PullManager, state?: NativePullState): Promise<void> {
  if (!nativePullSupported()) return;
  this.lastNativeSync = Date.now();
  const { items: list, running } = state ?? await nativeList();
  for (const row of list) {
    const rec = this.records[row.id] ?? this.adoptNative(row);
    if (!rec) {
      // A row this page no longer holds (superseded, deleted). Its bytes are
      // a file on the phone with nothing pointing at them — the one leak this
      // engine can produce, so it is swept here rather than left to storage
      // pressure.
      void nativeDiscard(row.id);
      continue;
    }
    const patch: Partial<PullRecord> = {
      engine: "native",
      nativeOwned: true,
      received: row.received,
      error: row.error || undefined,
      nextRetryAt: row.nextAt > Date.now() ? row.nextAt : undefined,
    };
    if (row.size > 0 && !rec.item.size) patch.item = { ...rec.item, size: row.size };
    if (row.etag) patch.etag = row.etag;
    if (row.received > rec.received) patch.lastProgressAt = Date.now();
    if (row.state === "done") {
      patch.state = "done";
      patch.nativeOwned = false;
      patch.nativePath = row.path;
      // Done, and the file is not there any more — the app's storage was
      // cleared, or the phone reclaimed it. That is exactly what `evicted`
      // means for a range download, and the row must offer a fresh fetch
      // rather than a save of bytes nobody has.
      patch.evicted = !row.path;
      patch.rate = undefined;
      patch.nextRetryAt = undefined;
      patch.error = undefined;
      // A `done` row's error can only be about publishing it — the download
      // itself finished. Dropping it with the rest left the page inventing a
      // generic sentence over the service's own specific one ("could not save
      // to Downloads: …"), which is the one thing that could have said why.
      if (row.error) { patch.saveError = row.error; patch.saveHandedAt = undefined; }
      // Published by the service itself. Recorded as a `device` save because
      // that is what it is — a file a file manager can see, named by
      // MediaStore — and `savedPresent` is true because the service asked the
      // folder before writing.
      // The install half of the same row. Written on every sync rather than
      // on a change, because the whole point is that these move while the
      // page is asleep — the service inspects the APK and may install it with
      // nothing on screen at all.
      if (row.pkg) {
        patch.pkg = row.pkg;
        patch.pkgLabel = row.pkgLabel;
        patch.pkgVersion = row.pkgVersion;
      }
      patch.install = row.install ?? "";
      patch.installError = row.installError || undefined;
      patch.installedAt = row.installedAt || undefined;
      // Carried as ABSENT where the shell never recorded it. Flattening to
      // `false` here made every install an older shell had done read as
      // "installed on a tap" in the desktop's log — a claim about a person,
      // about work nobody did.
      patch.installAuto = typeof row.installAuto === "boolean" ? row.installAuto : undefined;
      patch.installSnoozedUntil = row.installSnoozedUntil || undefined;
      patch.cleanedAt = row.cleanedAt || undefined;
      patch.cleanedBytes = row.cleanedAt ? row.cleanedBytes || undefined : undefined;
      patch.cleanNote = row.cleanNote || undefined;
      // The clean-up removed the Downloads copy too (the shell cleared `where`):
      // the row must stop pointing at a file it deleted.
      if (row.cleanedAt && !row.where && rec.savedTo && rec.saveVia === "device") {
        patch.savedTo = undefined;
        patch.savedPresent = undefined;
        patch.savedCheckedAt = undefined;
      }
      if (row.where) {
        if (rec.savedTo !== row.where) {
          patch.savedTo = row.where;
          patch.savedAt = Date.now();
          patch.saveVia = "device";
          patch.savedPresent = true;
          patch.savedCheckedAt = Date.now();
        }
        // The answer arrived — possibly a second after the bounded wait above
        // gave up on it. BOTH marks have to go, or the row goes on offering a
        // second save of a file already in Downloads, which is the MediaStore
        // duplicate this whole path exists to prevent.
        patch.saveError = undefined;
        patch.saveHandedAt = undefined;
      }
    } else if (row.state === "failed") {
      patch.state = "failed";
      // The service has given up. Ownership goes back, so a tap re-hands the
      // row over instead of retrying nothing.
      patch.nativeOwned = false;
      patch.attempts = row.attempts;
      patch.rate = undefined;
    } else if (row.state === "paused") {
      patch.state = "paused";
      patch.nativeOwned = false;
      patch.rate = undefined;
    } else if (row.state === "downloading") {
      patch.state = "downloading";
    } else if (rec.state === "downloading" || rec.state === "queued") {
      // `queued` in the service — a retry is counting down, or the platform
      // refused the start. Either way it is waiting, not running.
      patch.state = "queued";
      patch.attempts = row.attempts;
      // **The one state nothing else would ever recover from.** Android 15
      // refuses a background start of a `dataSync` service, and the service
      // catches that rather than crashing — so the row is accepted, queued,
      // and nothing is alive to run it. Ownership goes back, and the pump
      // hands it over again from the foreground, which is a start the
      // platform allows.
      if (!running && row.nextAt <= Date.now()) patch.nativeOwned = false;
    }
    this.patch(row.id, patch);
  }
  // A row this page believes the service is holding, which the service does
  // not have: its queue was cleared, or the enqueue never landed. Nothing
  // else would ever notice — the service reports only what it HAS — and the
  // row would sit at "downloading" for ever.
  const seen = new Set(list.map((r) => r.id));
  for (const rec of this.list()) {
    if (!rec.nativeOwned || seen.has(rec.item.id)) continue;
    this.patch(rec.item.id, {
      nativeOwned: false,
      state: rec.state === "done" ? "done" : "queued",
      rate: undefined,
    });
  }
}

/**
 * A row the shell's link service queued on its own: the host's `pull.new`
 * arrived while this document was frozen, so the service started the
 * download instead of leaving it for the next time the app was opened. It is
 * the host's item, verbatim — the same record `add()` would have made — and
 * it goes through the same supersede and shadow rules. Claiming it is an
 * `enqueue`, which clears the shell's mark: a row adopted once and later
 * dropped here is an orphan to discard, never a row to adopt again.
 */
export function pullAdoptNative(this: PullManager, row: NativePullRow): PullRecord | undefined {
  const item = row.origin === "link" ? row.item : undefined;
  if (!item || item.id !== row.id || !item.repoId || !item.relPath || this.removed.has(item.id)) return undefined;
  this.dropSuperseded(item.supersedes ?? []);
  if (this.shadowed(item)) return undefined;
  const rec: PullRecord = {
    item, state: "queued", received: row.received, attempts: row.attempts, updatedAt: Date.now(),
    engine: "native", nativeOwned: true,
  };
  this.records[item.id] = rec;
  this.persist();
  void nativeEnqueue({
    id: item.id, url: row.url, name: row.name, size: row.size || undefined, etag: row.etag || undefined,
  }).catch(() => undefined);
  return rec;
}

/** Ask at most every couple of seconds. `pump()` runs on a heartbeat, on every
 *  wake event and after every transfer, and a bridge call per pump is a cost
 *  paid for nothing. */
export function pullSyncNativeSoon(this: PullManager): void {
  if (!nativePullSupported()) return;
  if (Date.now() - this.lastNativeSync < NATIVE_SYNC_MS) return;
  void this.syncNative();
}
