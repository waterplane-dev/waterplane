import type { DictateAnswer, DictateStatus, HostStat } from "@waterplane/shared";
import { nfetch, jget, jpost } from "./webapiFetch";
import { rootApi } from "./webapiRoot";
import type { FileEntry, UploadError } from "./webapiTypes";

/** Desktop host: load, screen capture, dictation, clipboard. One slice of `api` (see api.ts). */
export const hostApi = {
  ...rootApi,
  // Desktop host: resource load + screen capture.
  hostStat: () => jget<HostStat>("/api/host/stat"),
  screenshot: async (repoId: string) => {
    // Tolerate the 500-on-failure path so the error message reaches the user.
    // POST because it has a side effect — see the note on the host handler.
    const r = await nfetch(`/api/host/screenshot?repo=${encodeURIComponent(repoId)}`, { method: "POST" });
    return r.json() as Promise<{ file?: FileEntry; error?: string }>;
  },
  /** Whether the desktop can read a whole picture ON-DEVICE (`ocrlocal.ts`). A
   *  reason, never a bare false — the annotator says it in place of the text. */
  ocrStatus: async (): Promise<{ available: true; engine: string } | { available: false; reason: string }> => {
    try {
      const r = await nfetch("/api/host/ocr");
      if (!r.ok) return { available: false, reason: "this desktop is running an older host" };
      return await r.json();
    } catch {
      return { available: false, reason: "the host could not be reached" };
    }
  },
  /**
   * Every word in one picture, read on the desktop and nowhere else — the
   * annotator's "text only". The bytes are the body because the picture may
   * never be uploaded (nothing is written, no repo), and the fuse is long: a phone photo is a
   * megabyte or two up a tunnel, and the desktop's first read may build its
   * reader. A reason is a 200, shown in place of the text.
   */
  ocrImage: async (img: Blob): Promise<{ text: string; engine: string; ms: number } | { error: string }> => {
    try {
      const r = await nfetch("/api/host/ocr", { method: "POST", headers: { "content-type": img.type || "image/jpeg" }, body: img }, 120_000);
      if (r.status === 404) return { error: "this desktop is running an older host — update it to read pictures on-device" };
      return await r.json();
    } catch {
      return { error: "the host could not be reached" };
    }
  },
  /**
   * Whether the desktop can turn speech into words, asked BEFORE the mic opens.
   *
   * A microphone button offered for a transcriber that is not installed is a
   * dead control, and on a phone a dead control explains nothing — so the
   * answer carries the REASON and the caller either draws no button (falling
   * back to the browser's own recogniser) or says why.
   */
  dictateStatus: async (): Promise<DictateStatus> => {
    try {
      const r = await nfetch("/api/host/dictate");
      if (!r.ok) return { available: false, reason: "this desktop is running an older host" };
      return (await r.json()) as DictateStatus;
    } catch {
      return { available: false, reason: "the host could not be reached" };
    }
  },
  /**
   * One recording, transcribed on the desktop.
   *
   * The bytes go up as the BODY, as `ocrImage`'s do: the audio exists
   * nowhere but the phone, nothing is written anywhere, and there is no repo in
   * the route. A reason comes back as a 200 — "nothing was said" and "no model
   * on that desktop" are answers to show, not failures to retry.
   *
   * **On XHR, and deliberately not on `nfetch`.** A minute of speech is 1.9 MB
   * and five minutes is 9.6 MB; `fetch` resolves on the RESPONSE HEADERS, which
   * on this route do not exist until every byte has been uploaded AND whisper
   * has run. So the whole transfer sat under `FETCH_TIMEOUT_MS` — the 20-second
   * fuse meant for small JSON — and a slow-but-alive tunnel had a minute of
   * somebody's speech aborted and thrown away. XHR is what the inbox upload
   * already uses for the same reason, and it brings the two things that make
   * the transfer survivable: byte PROGRESS (so the caller can bound SILENCE
   * rather than the transfer, `UPLOAD_STALL_MS`) and an abort that is the
   * caller's own.
   *
   * It REJECTS rather than answering `{error}` for anything that is not the
   * host's verdict, and marks whether the host `responded` — `dictateQueue.ts`
   * needs that difference: a verdict is final and a dead link is a wait.
   */
  dictate: (wav: Blob, opts: { lang?: string; terms?: string; signal?: AbortSignal; onProgress?: (sent: number, total: number) => void } = {}) =>
    new Promise<DictateAnswer>((resolve, reject) => {
      const { lang, terms, signal, onProgress } = opts;
      const xhr = new XMLHttpRequest();
      // The vocabulary rides in the query string beside the language: the body
      // is the WAV and nothing else, and the list is capped small by
      // `shared/dictateterms.ts` (60 terms) so the URL stays well under limits.
      const q = new URLSearchParams();
      if (lang) q.set("lang", lang);
      if (terms) q.set("terms", terms);
      const qs = q.toString();
      xhr.open("POST", `/api/host/dictate${qs ? `?${qs}` : ""}`);
      xhr.setRequestHeader("content-type", "audio/wav");
      xhr.withCredentials = true; // the LAN gate's token cookie
      if (onProgress) xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : wav.size);
      const onAbort = () => xhr.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const done = () => signal?.removeEventListener("abort", onAbort);
      xhr.onload = () => {
        done();
        // A 200 carrying `{error}` IS the desktop's verdict on this audio (no
        // model installed, nothing said, not a WAV it can read) and will not
        // change on a retry. Every other status decided nothing about the
        // recording: 401/403 is the LAN gate, 5xx is a host mid-restart.
        if (xhr.status < 200 || xhr.status > 299) {
          const err = new Error(`the desktop could not read it (${xhr.status})`) as UploadError;
          err.permanent = xhr.status === 413 || xhr.status === 415;
          err.responded = true;
          reject(err);
          return;
        }
        try { resolve(JSON.parse(xhr.responseText) as DictateAnswer); }
        catch {
          const err = new Error("the desktop answered something this app could not read") as UploadError;
          err.responded = true;
          reject(err);
        }
      };
      xhr.onerror = () => { done(); reject(new Error("the desktop could not be reached")); };
      xhr.onabort = () => { done(); reject(new DOMException("aborted", "AbortError")); };
      xhr.send(wav);
    }),
  /** Push text onto the desktop host's system clipboard (phone→desktop). */
  setClipboard: (text: string) =>
    jpost<{ ok: boolean; chars?: number; error?: string }>("/api/host/clipboard", { text }),
  /** One file of an extension's `assets` folder (`GET /api/plugin/<id>/asset/<file>`), behind the
   *  same origin + token gates as every call here; the RESPONSE, so the caller can stream it with
   *  progress (`sdk/extAssets.ts`). The fuse covers the headers; the body is the caller's to time. */
  pluginAsset: (id: string, file: string, signal?: AbortSignal) =>
    nfetch(`/api/plugin/${encodeURIComponent(id)}/asset/${encodeURIComponent(file)}`, { signal, cache: "no-store" }, 30_000),
};
