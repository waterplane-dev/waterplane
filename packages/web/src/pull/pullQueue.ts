import type { PullItem } from "@waterplane/shared";
import { idbDel } from "../idb";
import { nativeCancel, nativeDiscard, nativePullSupported } from "../nativePull";
import { lsSetJson } from "../storage";
import { fileMatch, needsFetch, noNetwork, strandedDownload, syncKeeps } from "../downloadState";
import { linkOnline } from "../link";
import type { PullRecord, LocalPull } from "./pullTypes";
import { LS_STATE, MAX_ATTEMPTS, MAX_RECORDS, localPullId, autoPull } from "./pullConsts";
import type { PullManager } from "./pullManager";

/**
 * Write the queue down, capped.
 *
 * Two rules the cap did not used to have, both now reachable because a tap
 * adds rows of its own on top of the host's 200:
 *
 *  - **What is dropped takes its bytes with it.** Nothing ever enumerates the
 *    `pulls` store, so a record evicted here without an `idbDel` stranded its
 *    blob — megabytes with nothing pointing at them, on the storage-pressured
 *    phone this app targets.
 *  - **What gets dropped is chosen, not just oldest.** Finished-and-saved rows
 *    go first; a row a person asked for and has not received, and the transfer
 *    actually running, are the last things to go — dropping either is losing
 *    the download rather than tidying the list.
 */
export function pullPersist(this: PullManager): void {
  const all = this.list();
  let next: Record<string, PullRecord> = {};
  if (all.length <= MAX_RECORDS) {
    for (const r of all) next[r.item.id] = r;
  } else {
    const precious = (r: PullRecord) =>
      this.active === r.item.id || (r.local && r.state !== "done") || (r.state === "done" && !r.savedAt && !r.evicted);
    // Newest-first within each class, so "oldest goes" still holds inside one.
    const ordered = [...all.filter(precious), ...all.filter((r) => !precious(r))];
    for (const r of ordered.slice(0, MAX_RECORDS)) next[r.item.id] = r;
    for (const r of ordered.slice(MAX_RECORDS)) {
      void idbDel("pulls", r.item.id);
      if (r.nativePath) void nativeDiscard(r.item.id);
    }
  }
  this.records = next;
  lsSetJson(LS_STATE, next);
  this.emit();
}

export function pullPatch(this: PullManager, id: string, fields: Partial<PullRecord>): void {
  const cur = this.records[id];
  if (!cur) return;
  this.records[id] = { ...cur, ...fields, updatedAt: Date.now() };
  this.persist();
}

// ── host queue sync ───────────────────────────────────────────────
/**
 * Reconcile with the host's queue. Items the host dropped are forgotten UNLESS
 * we already hold their bytes — dismissing a queue entry must not delete a file
 * that finished downloading, that is the one thing the user came for.
 */
export function pullSync(this: PullManager, items: PullItem[]): void {
  this.dropSuperseded(items.flatMap((i) => i.supersedes ?? []));
  // Belt and braces for a phone that was away while several builds landed: the
  // host drops each older entry as the next one is queued, so the ids item N-1
  // superseded are not on item N's list — nobody who reconnects at item N ever
  // sees them. Compare families directly against what the host still holds.
  for (const item of items) {
    if (!item.family) continue;
    this.dropSuperseded(
      this.list()
        .filter((r) => r.item.id !== item.id && r.item.repoId === item.repoId
          && (r.item.family ?? "") === item.family && r.item.mtime < item.mtime)
        .map((r) => r.item.id),
    );
  }
  const live = new Set(items.map((i) => i.id));
  for (const item of items) {
    const cur = this.records[item.id];
    if (cur) this.records[item.id] = { ...cur, item };
    else if (this.shadowed(item)) continue;  // this device already asked for that file
    else this.records[item.id] = { item, state: "queued", received: 0, attempts: 0, updatedAt: Date.now() };
  }
  for (const id of Object.keys(this.records)) {
    if (syncKeeps(this.records[id], live.has(id), this.active === id)) continue;
    delete this.records[id];
    void idbDel("pulls", id);
  }
  this.persist();
  void this.evictOld();
  this.pump();
}

/** A single freshly-queued item (the `pull.new` broadcast). */
export function pullAdd(this: PullManager, item: PullItem): void {
  this.dropSuperseded(item.supersedes ?? []);
  // The host queues what its rules say is worth having; if this device already
  // asked for that exact file by hand, the two are one download, not two rows.
  if (this.shadowed(item)) { this.persist(); return; }
  if (!this.records[item.id]) {
    this.records[item.id] = { item, state: "queued", received: 0, attempts: 0, updatedAt: Date.now() };
    this.persist();
  }
  this.pump();
}

/**
 * "I want this file", from a tap anywhere in the app.
 *
 * The record is LOCAL: no `pull.add`, no round trip, nothing the host has to
 * be reachable for beyond the bytes themselves. Returns the record's id, and
 * is idempotent — asking twice for the same file resumes the first request
 * rather than starting a second copy of it.
 */
export function pullAddLocal(this: PullManager, t: LocalPull, opts: { autoSave?: boolean } = {}): string {
  const mtime = Math.round(t.mtime ?? 0);
  const existing = this.findFor(t.repoId, t.relPath, mtime);
  if (existing) {
    const patch: Partial<PullRecord> = { local: true };
    if (opts.autoSave) patch.autoSave = true;
    // A row created blind — a notification carries no mtime — becomes THIS
    // version the moment a caller knows which one it is. Without that, one
    // mtime-less row matches every future build of the same path, and next
    // week's tap hands over last week's bytes under this week's name.
    if (!existing.item.mtime && mtime) patch.item = { ...existing.item, mtime, size: existing.item.size || Math.round(t.size ?? 0) };
    this.patch(existing.item.id, patch);
    // `needsFetch`, not "is it done": an EVICTED record is `done` with no
    // bytes, and a tap on it must fetch rather than silently do nothing.
    if (needsFetch(existing)) this.retry(existing.item.id);
    return existing.item.id;
  }
  const id = localPullId(t.repoId, t.relPath, mtime);
  const item: PullItem = {
    id,
    repoId: t.repoId,
    repoDir: t.repoDir ?? "",
    repoName: t.repoName ?? "",
    name: t.name || t.relPath.split("/").pop() || t.relPath,
    relPath: t.relPath,
    size: Math.max(0, Math.round(t.size ?? 0)),
    mtime,
    ts: Date.now(),
    source: "manual",
    // Only a plugin-offered file: an app-relative path, never a full URL (`artifactUrl` pins the host).
    ...(t.src && t.src.startsWith("/api/plugin-file/") ? { src: t.src } : {}),
  };
  this.records[id] = {
    item, state: "queued", received: 0, attempts: 0, updatedAt: Date.now(),
    local: true, autoSave: !!opts.autoSave,
  };
  this.persist();
  // Force: a tap outranks the auto-download switch and any backoff.
  this.pump(true, id);
  return id;
}

/** The record for a file, if this device has one. Exact (repo + path + mtime)
 *  first, then the loose match `fileMatch` allows when one side does not know
 *  the mtime — never a different KNOWN mtime, which is a rebuilt artifact and
 *  a different file. */
export function pullFindFor(this: PullManager, repoId: string, relPath: string, mtime?: number): PullRecord | undefined {
  const hits = this.list();
  return hits.find((r) => fileMatch(r, repoId, relPath, mtime) === "exact")
    ?? hits.find((r) => fileMatch(r, repoId, relPath, mtime) === "loose");
}

/**
 * Is this host queue entry the same file a local record already covers?
 *
 * The adoption is written IN PLACE rather than through `patch()` on purpose:
 * this runs inside `sync()`'s loop over the host's items, and `patch` persists
 * and emits — re-entering every subscriber, and re-capping `records`, halfway
 * through a reconciliation. Both callers persist when they are done.
 */
export function pullShadowed(this: PullManager, item: PullItem): boolean {
  if (this.records[item.id]) return false;
  const hit = this.findFor(item.repoId, item.relPath, item.mtime);
  if (!hit?.local) return false;
  // The host always knows the mtime; a local row created blind does not. Adopt
  // it, so this row is one VERSION of the file rather than a permanent shadow
  // over every future build of that path.
  if (!hit.item.mtime && item.mtime) {
    hit.item = { ...hit.item, mtime: item.mtime, size: hit.item.size || item.size };
    this.records[hit.item.id] = { ...hit, updatedAt: Date.now() };
  }
  return true;
}

/**
 * A newer version of the same artifact was queued: forget these and throw away
 * whatever of them is on disk.
 *
 * This is the whole point of the feature on a bad link — five 23 MB APKs of
 * the same build queued over an afternoon means the phone spends 115 MB to end
 * up with one file it wants and four it doesn't, and the one it wants is LAST
 * in a queue that runs one download at a time. So an in-flight transfer for a
 * superseded item is ABORTED, not allowed to finish: its bytes are a build
 * that has already been replaced.
 *
 * A `done` record is kept regardless — the file is already on the phone, it
 * cost nothing more to keep, and deleting something the user asked for because
 * a newer one exists is the one move this must never make.
 */
export function pullDropSuperseded(this: PullManager, ids: string[]): void {
  let changed = false;
  for (const id of ids) {
    const rec = this.records[id];
    if (!rec || rec.state === "done") continue;
    if (this.active === id) { this.abort?.abort(); this.active = null; }
    delete this.records[id];
    void nativeDiscard(id);
    void idbDel("pulls", id);
    changed = true;
  }
  if (changed) this.persist();
}

/** Manual "get it now" — also the way a `failed`, `paused` or evicted record
 *  is un-stuck. A user tap always tries, whatever the switches say. */
export function pullRetry(this: PullManager, id: string): void {
  const r = this.records[id];
  if (!r) return;
  if (r.state === "done" && !r.evicted) return;
  // A transfer in flight is never a candidate. Not just the one in `active`:
  // a Background Fetch runs with the slot already freed (the pump hands over
  // and moves on), so an `active`-only guard let a tap re-register the live id
  // — which throws, falls through to the range engine, and downloads the whole
  // file a SECOND time in parallel over the metered link this queue exists to
  // protect. Boot-time revival of a genuinely orphaned `downloading` row is
  // `start()`'s job, not a tap's.
  if (r.state === "downloading") return;
  this.patch(id, {
    state: "queued", attempts: 0, error: undefined, nextRetryAt: undefined, evicted: false,
    // A tap is the one thing that may re-hand a row to the native service:
    // its enqueue clears the backoff and the give-up count, which is exactly
    // what "retry" means and exactly what the pump must not do by itself.
    nativeOwned: false,
  });
  this.pump(true, id);
}

/** Forget a record and its bytes (the sheet's delete). */
export async function pullRemove(this: PullManager, id: string): Promise<void> {
  if (this.active === id) { this.abort?.abort(); this.active = null; }
  delete this.records[id];
  this.persist();
  void nativeDiscard(id);
  await idbDel("pulls", id);
}

/** Stop the running transfer but keep the bytes — it resumes from the offset.
 *  `paused` is its own state on purpose: parking it back in `queued` meant the
 *  next pump restarted it immediately, so Pause visibly did nothing. */
export function pullPause(this: PullManager, id?: string): void {
  // A native transfer is not in `active` — the page hands it over and frees
  // the slot — so pausing one is a message, not an abort. The row's id is
  // what the button has; the running one is the fallback for callers that
  // predate this argument.
  const target = id ?? this.active;
  if (!target) return;
  const rec = this.records[target];
  if (rec?.engine === "native") {
    void nativeCancel(target);
    this.patch(target, { state: "paused", rate: undefined, nextRetryAt: undefined });
    return;
  }
  if (this.active !== target) return;
  this.abort?.abort();
  this.active = null;
  this.patch(target, { state: "paused", rate: undefined, nextRetryAt: undefined });
}

/** Un-stick everything a bad link left behind, in one tap. */
export function pullResumeAll(this: PullManager): void {
  for (const r of this.list()) {
    if (r.state === "queued" || r.state === "paused" || r.state === "failed") {
      this.patch(r.item.id, { state: "queued", attempts: 0, error: undefined, nextRetryAt: undefined, nativeOwned: false });
    }
  }
  this.pump(true);
}

/**
 * Why is nothing moving? A queue that sits still with no explanation reads as
 * a broken button — which is exactly how it was reported.
 */
export function pullWhyIdle(this: PullManager): string | null {
  if (this.active) return null;
  // A row that says `downloading` while nothing is carrying it is the one
  // state this function used to be blind to — it inspected queued/paused/
  // failed only, so the single case where the queue is genuinely stuck with a
  // spinner on it produced no sentence at all. Answered first, because it
  // outranks every reason below: those are about rows that WILL run.
  const stuck = this.list().filter((r) => strandedDownload(r, {
    activeId: this.active, nativeSupported: nativePullSupported(),
  }));
  if (stuck.length) {
    return "a transfer was interrupted and nothing is carrying it — putting it back in the queue";
  }
  const waiting = this.list().filter((r) => r.state === "queued" || r.state === "paused" || r.state === "failed");
  if (!waiting.length) return null;
  if (!autoPull() && waiting.every((r) => !r.local)) return "auto-download is off — tap a file to fetch it now";
  if (noNetwork(navigator.onLine, linkOnline())) return "the phone reports no network — will start when it is back";
  if (waiting.every((r) => r.state === "paused")) return "paused — tap resume";
  if (waiting.every((r) => r.state === "failed" || r.attempts >= MAX_ATTEMPTS)) return "stopped after repeated failures — tap retry";
  // Mixed — one paused, one given up — fell through every `every()` above and
  // said nothing, which is the state this whole function exists to prevent.
  if (waiting.every((r) => r.state === "paused" || r.state === "failed" || r.attempts >= MAX_ATTEMPTS)) {
    return "nothing is running — each row below says why";
  }
  return null;
}
