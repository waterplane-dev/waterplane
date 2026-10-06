import type { HostStoreOutcome, HostStoreReport, TransportSurvey, SweepAge, SweepResult, SweepScope, SweepTally } from "@waterplane/shared";
import { nfetch, jget, jpost } from "./webapiFetch";
import type { FileEntry, ArtifactKind, SearchHit, UploadError } from "./webapiTypes";

/** Inbox, outbox, uploads, sweep and the host store. One slice of `api` (see api.ts). */
export const filesApi = {
  inbox: (repoId: string) => jget<{ files: FileEntry[] }>(`/api/repos/${repoId}/inbox`).then((d) => d.files),

  /** Clear the inbox unread badge. Best-effort — a failure must not break the view. */
  markInboxSeen: (repoId: string) =>
    fetch(`/api/repos/${repoId}/inbox/seen`, { method: "POST" }).catch(() => undefined),

  /** Clear the outbox unread badge (the repo "things to look at" count).
   *  Best-effort — a failure must not break the view. */
  markOutboxSeen: (repoId: string) =>
    fetch(`/api/repos/${repoId}/artifacts/seen`, { method: "POST" }).catch(() => undefined),

  artifacts: (repoId: string, scope: "repo" | "outbox", sinceSeconds?: number, opts?: { query?: string; kind?: ArtifactKind; limit?: number }) => {
    const q = new URLSearchParams({ scope });
    if (sinceSeconds) q.set("since", String(sinceSeconds));
    if (opts?.query) q.set("q", opts.query);
    if (opts?.kind && opts.kind !== "all") q.set("kind", opts.kind);
    if (opts?.limit) q.set("limit", String(opts.limit));
    return jget<{ files: FileEntry[]; truncated: boolean }>(`/api/repos/${repoId}/artifacts?${q}`);
  },

  search: (opts: { query?: string; kind?: ArtifactKind; scope?: "repo" | "outbox"; sinceSeconds?: number; repoIds?: string[]; limit?: number }) => {
    const q = new URLSearchParams({ scope: opts.scope ?? "repo" });
    if (opts.query) q.set("q", opts.query);
    if (opts.kind && opts.kind !== "all") q.set("kind", opts.kind);
    if (opts.sinceSeconds) q.set("since", String(opts.sinceSeconds));
    if (opts.repoIds?.length) q.set("repos", opts.repoIds.join(","));
    if (opts.limit) q.set("limit", String(opts.limit));
    return jget<{ hits: SearchHit[]; truncated: boolean }>(`/api/search?${q}`);
  },

  /**
   * Upload one image into the repo inbox. XHR rather than fetch for ONE reason:
   * `upload.onprogress`. A phone screenshot on a slow uplink is tens of seconds
   * during which the compose bar is blocked ("Send waits for uploads"), and a
   * spinner with no numbers is indistinguishable from a hang — see the strip in
   * App.tsx. Streaming request bodies would give fetch the same thing, but they
   * need HTTP/2 + duplex and are unavailable on the browsers this runs on.
   */
  uploadInbox: (
    repoId: string, file: Blob, filename: string,
    signal?: AbortSignal, onProgress?: (sent: number, total: number) => void,
    /** This upload came out of the send queue and may be a RE-send (dropped
     *  tunnel, killed tab). The host then answers with the file already on disk
     *  under this exact name+size instead of writing a second copy — the queue
     *  has no ackId ledger on the HTTP path. */
    dedupe?: boolean,
  ) => new Promise<{ saved: FileEntry[]; skipped: { name: string; error: string }[] }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/repos/${repoId}/inbox`);
    // Percent-encoded: HTTP headers are Latin-1 and the browser THROWS on a
    // header value with anything outside it — an umlaut in a document name
    // killed the upload before it started. The host decodes it back.
    xhr.setRequestHeader("x-file-name", encodeURIComponent(filename));
    if (dedupe) xhr.setRequestHeader("x-dedupe", "1");
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.withCredentials = true; // the LAN gate's token cookie
    if (onProgress) xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : file.size);
    const onAbort = () => xhr.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => signal?.removeEventListener("abort", onAbort);
    xhr.onload = () => {
      done();
      // The host answers 200 + `{saved, skipped}` even when it REFUSES a file
      // (`.env`, unknown type) — that is a real verdict and the caller fails the
      // entry on it. Any other status is not a verdict at all: 401/403 is the
      // LAN gate or the origin guard, 5xx is the host mid-restart, and
      // `xhr.onload` fires for all of them. Resolving there made a transient
      // condition look like "the host refused the file" and the queue entry was
      // failed for good — with its bytes then dropped from IndexedDB, so the
      // image was unrecoverable. Reject instead, so the upload is requeued.
      if (xhr.status < 200 || xhr.status > 299) {
        const err = new Error(`upload failed (${xhr.status})`) as UploadError;
        // 413/415 will not change on a retry; everything else might.
        err.permanent = xhr.status === 413 || xhr.status === 415;
        err.responded = true; // a status IS an answer, even a wrong one
        reject(err);
        return;
      }
      try { resolve(JSON.parse(xhr.responseText)); }
      catch {
        const err = new Error(`upload failed (${xhr.status})`) as UploadError;
        err.responded = true;
        reject(err);
      }
    };
    xhr.onerror = () => { done(); reject(new Error("upload failed")); };
    xhr.onabort = () => { done(); reject(new DOMException("aborted", "AbortError")); };
    xhr.send(file);
  }),

  deleteInbox: (repoId: string, name: string) =>
    nfetch(`/api/repos/${repoId}/inbox/${encodeURIComponent(name)}`, { method: "DELETE" }).then((r) => r.json()),
  /** Delete an outbox/repo artifact by worktree-relative path (host guards it to inbox/outbox). */
  deleteArtifact: (repoId: string, relPath: string) =>
    nfetch(`/api/repos/${repoId}/artifact?path=${encodeURIComponent(relPath)}`, { method: "DELETE" }).then((r) => r.json()),

  /**
   * Everything in one transport directory, with the per-age tallies — the PLAN,
   * which writes nothing. The cut itself runs here (`shared/sweep.ts`), so the
   * number on a chip and the list that chip opens are one function.
   *
   * Deliberately NOT the gallery listing: that one filters by what the phone
   * can paint, and a cleanup which inherited that filter would call a directory
   * clean while leaving every `.zip` in it.
   */
  sweepPlan: (repoId: string, scope: SweepScope) =>
    nfetch(`/api/repos/${repoId}/sweep?scope=${scope}`).then((r) => r.json() as Promise<{
      scope: SweepScope; rows: FileEntry[]; total: SweepTally; counts: Record<SweepAge, SweepTally>;
    }>),
  /**
   * Delete exactly these paths.
   *
   * The list is the contract — the host never re-derives it from an age (see
   * `shared/sweep.ts`). A person approved a set of rows; this sends that set.
   */
  sweepRun: (repoId: string, paths: string[]) =>
    jpost<SweepResult & { error?: string }>(`/api/repos/${repoId}/sweep`, { paths }),

  /**
   * Every repo, ranked by what its transport directories hold.
   *
   * The per-repo sweep answers one repo at a time and is reached from that
   * repo's gallery, so finding the fat one means already knowing which it is.
   * Each row's two tallies come from the same `listTransport` the sweep serves,
   * so a row and the sheet it opens cannot disagree.
   */
  transportSurvey: () => nfetch("/api/storage/transport").then((r) => r.json() as Promise<TransportSurvey>),

  /** What the daemon's own store holds, by owner and by bound. */
  hostStore: () => nfetch("/api/storage/host").then((r) => r.json() as Promise<HostStoreReport>),
  /**
   * Clear one catalogue row of the desktop's store.
   *
   * Carries an ID and the INSTANT the report was read — never a path. The host
   * derives every filename itself (`host/hoststore.ts`), and `at` is what keeps
   * the clear inside the reading the person actually looked at.
   */
  hostStoreClear: (store: string, at: number) =>
    jpost<HostStoreOutcome & { error?: string }>("/api/storage/host/clear", { store, at }),
};
