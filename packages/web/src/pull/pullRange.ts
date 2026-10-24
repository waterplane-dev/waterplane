import { idbDel, idbGet, idbSet } from "../idb";
import { nativeDiscard } from "../nativePull";
import type { PullRecord, PullBlob } from "./pullTypes";
import { FLUSH_BYTES, FLUSH_MS, HEADERS_TIMEOUT_MS, STALL_MS, KEEP_DONE_MS, artifactUrl } from "./pullConsts";
import { typedBlob } from "./pullMime";
import type { PullManager } from "./pullManager";

// ── engine 2: resumable Range fetch ───────────────────────────────
/**
 * Fetch what is missing and append it. Every branch here exists because of a
 * specific way a resume goes wrong:
 *
 *  - a server that ignores `Range` answers 200 with the WHOLE body, so the
 *    stored prefix has to be thrown away rather than prepended to a full copy;
 *  - a file rewritten between attempts (a rebuilt APK) has a new ETag, and
 *    appending to the old prefix yields a corrupt file that looks complete;
 *  - the offset is re-read from storage rather than trusted from the record,
 *    because the record is in localStorage and the bytes are in IndexedDB, and
 *    a write that lands in one but not the other must not silently misalign.
 */
export async function pullRangeFetch(this: PullManager, id: string): Promise<void> {
  const rec = this.records[id];
  if (!rec) return;
  const stored = await idbGet<PullBlob>("pulls", id);
  let have = stored?.blob ?? new Blob([]);
  let received = stored ? Math.min(stored.received, stored.blob?.size ?? 0) : 0;
  if (received !== have.size) { have = new Blob([]); received = 0; } // disagreement ⇒ restart

  const ctl = new AbortController();
  this.abort = ctl;
  // Two fuses, because a bad link fails by going QUIET, not by erroring: a
  // fetch against a dead Tailscale path hangs indefinitely, and a hung fetch
  // pins `active` — the queue stops and the retry button provably does
  // nothing, since pump() refuses to start a second transfer. The first fuse
  // covers "no response headers", the second "headers came, bytes stopped".
  let fuse = setTimeout(() => ctl.abort(), HEADERS_TIMEOUT_MS) as unknown as number;
  const rearm = (ms: number) => {
    clearTimeout(fuse);
    fuse = setTimeout(() => ctl.abort(), ms) as unknown as number;
  };

  try {
    const headers: Record<string, string> = {};
    if (received > 0) headers.Range = `bytes=${received}-`;
    if (received > 0 && rec.etag) headers["if-range"] = rec.etag;

    // A resumable Range loop, not a JSON call. It streams bytes under its own
    // AbortController and its own stall watchdog (`rearm`) — a stricter fuse
    // than the shared one, which would cut a slow but healthy download short.
    // eslint-disable-next-line no-restricted-globals -- streaming Range loop
    const res = await fetch(artifactUrl(rec.item), { headers, signal: ctl.signal, cache: "no-store" });
    rearm(STALL_MS);

    // The file shrank (or was replaced by a smaller one) under a stored
    // offset that is now past its end. Throw the prefix away and start over
    // rather than resuming into nothing — the host answers 416 exactly so this
    // case is detectable instead of silently appending to garbage.
    if (res.status === 416) {
      await idbDel("pulls", id);
      this.patch(id, { received: 0, etag: undefined });
      throw new Error("stored part no longer matches — starting over");
    }
    if (!res.ok && res.status !== 206) {
      // 403 here is almost never "forbidden file" — it is the host's
      // same-origin guard turning the request away, which is a setup problem
      // and needs to say so rather than read as a flaky link.
      const e = new Error(res.status === 403
        ? "http 403 — the host refused this request (origin not allowed)"
        : `http ${res.status}`) as Error & { permanent?: boolean };
      // A file the host will never hand over is not a connectivity problem,
      // and retrying it 50 times only hides the ones that are.
      e.permanent = res.status === 403 || res.status === 404 || res.status === 410;
      throw e;
    }
    const etag = res.headers.get("etag") || undefined;

    // 200 where we asked for a range = the server sent everything (or the file
    // changed and `if-range` was declined). Start over from this body.
    if (res.status === 200 && received > 0) { have = new Blob([]); received = 0; }

    const total = res.status === 206
      ? Number((res.headers.get("content-range") || "").split("/")[1] || 0) || rec.item.size
      : Number(res.headers.get("content-length") || 0) || rec.item.size;

    if (!res.body) {
      // No streaming reader (very old browser): one shot, no progress.
      const blob = await res.blob();
      // Typed by NAME (`pullMime.ts`): a merged Blob would otherwise be typeless and sniffed.
      const merged = typedBlob(received > 0 ? [have, blob] : [blob], rec.item.name);
      await this.store(id, merged, merged.size, total, rec.item.name);
      this.patch(id, { state: "done", received: merged.size, etag, rate: undefined });
      return;
    }

    const reader = res.body.getReader();
    let pending: BlobPart[] = [];
    let pendingBytes = 0;
    let lastFlush = Date.now();
    this.patch(id, { engine: "range", etag, received, lastProgressAt: Date.now() });

    const flush = async () => {
      if (!pendingBytes) return;
      const now = Date.now();
      const bytes = pendingBytes;
      have = typedBlob([have, ...pending], rec.item.name);
      pending = [];
      pendingBytes = 0;
      received = have.size;
      await this.store(id, have, received, total, rec.item.name);
      const dt = Math.max(1, now - lastFlush) / 1000;
      lastFlush = now;
      const inst = bytes / dt;
      const prev = this.records[id]?.rate;
      this.patch(id, {
        received,
        // Smoothed: a raw per-flush figure on a mobile link swings by an order
        // of magnitude and is unreadable.
        rate: prev ? prev * 0.7 + inst * 0.3 : inst,
        lastProgressAt: now,
        wireBytes: (this.records[id]?.wireBytes ?? 0) + bytes,
      });
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rearm(STALL_MS);
        pending.push(value);
        pendingBytes += value.byteLength;
        if (pendingBytes >= FLUSH_BYTES || Date.now() - lastFlush >= FLUSH_MS) await flush();
      }
    } catch (e) {
      // A dropped link mid-stream: keep what has been flushed and let the retry
      // resume from there. Anything unflushed is simply re-fetched.
      await flush().catch(() => undefined);
      throw e;
    }
    await flush();

    // A truncated transfer that ended without an error still isn't done.
    if (total > 0 && received < total) throw new Error(`incomplete (${received}/${total})`);
    this.patch(id, { state: "done", received, error: undefined, rate: undefined, nextRetryAt: undefined });
  } finally {
    clearTimeout(fuse);
  }
}

export async function pullStore(this: PullManager, id: string, blob: Blob, received: number, total: number, name: string): Promise<void> {
  // The record can be gone by the time a flush lands — a superseded item is
  // deleted (bytes and all) while its stream is still being aborted, and
  // writing here afterwards would leave the megabytes of a build that has
  // already been replaced orphaned in IndexedDB with nothing pointing at them.
  if (!this.records[id]) return;
  await idbSet("pulls", id, { id, blob, received, total, name } satisfies PullBlob);
}

/** Drop the bytes of downloads finished long ago. The record stays (so the
 *  sheet can still say "you had this"), the megabytes don't. */
export async function pullEvictOld(this: PullManager): Promise<void> {
  const cutoff = Date.now() - KEEP_DONE_MS;
  for (const r of this.list()) {
    if (r.state === "done" && !r.evicted && r.updatedAt < cutoff && r.received > 0) {
      await this.dropOne(r);
    }
  }
}

/**
 * Throw away one finished download's bytes, keeping its record.
 *
 * The body `evictOld` used to hold inline, lifted out so the automatic
 * seven-day eviction and the storage screen's by-hand one are ONE
 * implementation — two copies of "what it means to drop a download" is how
 * the by-hand one comes to forget the native file and leave the megabytes
 * exactly where the tap said they would not be.
 */
export async function pullDropOne(this: PullManager, r: PullRecord): Promise<void> {
  await idbDel("pulls", r.item.id);
  // The native engine's copy is a file, and it is the same megabytes.
  if (r.nativePath) await nativeDiscard(r.item.id);
  // Stays `done`, flagged `evicted`. Re-queuing it here is what made a
  // week-old 24 MB APK download itself again on its own — the bytes were
  // dropped deliberately, so fetching them back is a tap.
  this.patch(r.item.id, { received: 0, evicted: true, nativePath: undefined });
}

/**
 * Drop the bytes of exactly these downloads, now — the storage screen's
 * button (`storageAudit.ts`).
 *
 * **Takes ids, never a rule.** The screen showed a person a list and a byte
 * total; re-deriving "everything finished and saved out" here would delete a
 * set nobody approved, which is `sweep.ts`' rule about the plan being the
 * contract, in the one place on the phone where it also applies.
 *
 * Idempotent and conservative: an id that is unknown, still transferring, or
 * already evicted is skipped rather than forced, so a double tap cannot
 * abort a running download. Answers what it actually dropped.
 */
export async function pullDropBytes(this: PullManager, ids: string[]): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  for (const id of ids) {
    const r = this.records[id];
    if (!r || r.state !== "done" || r.evicted) continue;
    const had = r.received || r.item.size || 0;
    await this.dropOne(r);
    count++;
    bytes += had;
  }
  return { count, bytes };
}
