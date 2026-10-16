/**
 * The upload buffer: the ordered batch an annotate flow fills, image by image,
 * whose bytes ride the send queue (`queueImageUpload` → `runUpload`). Its
 * progress row is the composer's; its bytes are the queue's — which is why it
 * lives here and not in the images feature.
 *
 * Background image uploads for the session annotate flow. Each per-image "Send"
 * fires an upload into an ordered slot and returns immediately, so the next
 * image can be annotated while the previous one uploads. Refs land in compose
 * (in picked order) once every upload for the batch finishes; `submit` fires
 * the send then. Compose Send stays gated until the buffer drains.
 */
import { useEffect, useRef, useState } from "react";
import { copyText } from "../../api";
import { withUploadSize } from "../../annNote";
import { fmtSize } from "../../format";
import { showToast } from "../../toast";
import { useLinger } from "../../useLinger";
import { effectiveMaxWidth, etaText, scaleForUpload } from "../../uploadScale";
import { sendModeToast } from "../../composeSend";
import type { UploadBuf, UploadProgress } from "../../sdk/types.ts";
import { UPLOAD_ROW_LINGER_MS, isLaterId } from "./logic.ts";
import type { QueueCtx, UploadFns, UploadState } from "./types.ts";

/** The buffer's state and the label it draws. Nothing here reaches the queue:
 *  `runUpload` writes the byte counters, this turns them into words. */
export function useUploadState(): UploadState {
  const [uploading, setUploading] = useState<string | null>(null); // background upload progress label
  /** `parkingRef`, for render. The only upload state Send still waits on. */
  const [parking, setParking] = useState(0);
  // Byte-level progress for the strip. A spinner alone can't be told apart from
  // a hang, and on a slow uplink a screenshot is tens of seconds of blocked Send.
  const [upProg, setUpProg] = useState<UploadProgress | null>(null);
  const inflightRef = useRef(0); // uploads not yet settled, across ALL draining buffers (drives the progress row)
  /**
   * Of those, the ones still being ENCODED AND PARKED — the only window in which
   * sending is genuinely premature.
   *
   * Split out of `inflightRef` because that counter was blocking Send for the
   * whole transfer, and `runUpload`'s own comment had already noticed the
   * contradiction: *"the transfer is the queue's now, but it is still the thing
   * blocking Send"*. Once the bytes are parked, the path is in the text and
   * `guardUploadRefs` adopts the upload into this lane, where one-delivery-per-
   * lane makes the prompt wait for the picture by construction (`releaseLane()`
   * at the end of `runUpload` is that rule firing). Blocking the composer on top
   * of that bought nothing and cost the person watching a 99% progress bar the
   * only control on the screen.
   *
   * Before the park there is nothing to order against: the text has no path in
   * it yet, so a prompt sent now names no picture at all. That window is
   * milliseconds and it is the one this counter keeps.
   */
  const parkingRef = useRef(0);
  // Aggregate byte counters for the progress strip. `total` grows as blobs
  // finish encoding/scaling (a batch doesn't know its size up front), so the
  // percentage can dip when a new image joins — honest, and better than a
  // number that only counts the first file.
  const upBytesRef = useRef({ sent: 0, total: 0, startedAt: 0, fullAt: 0 });
  const allBufsRef = useRef<Set<UploadBuf>>(new Set()); // every live buffer, so cancel aborts all
  const uploadBufRef = useRef<UploadBuf | null>(null);

  /** Progress label reflects the global in-flight count across all draining
   *  buffers, plus how many BYTES of it have actually gone up. */
  function refreshUploadLabel() {
    const n = inflightRef.current;
    setParking(parkingRef.current);
    if (n <= 0) {
      upBytesRef.current = { sent: 0, total: 0, startedAt: 0, fullAt: 0 };
      setUploading(null);
      setUpProg(null);
      return;
    }
    const now = Date.now();
    const { sent, total, startedAt } = upBytesRef.current;
    const elapsed = startedAt ? now - startedAt : 0;
    // Only claim a rate once enough has moved for it to mean anything.
    const kbps = elapsed > 700 && sent > 40_000 ? sent / 1024 / (elapsed / 1000) : null;
    // Every byte is out and nobody has answered yet. This is NOT the transfer
    // still running: an upload settles on the host's RECEIPT (runUpload only
    // clears the entry when the POST resolves), so the last progress event is
    // followed by a silence of unknown length while the host writes the file.
    // Reported as 99% + "83 kB/83 kB" it read as a transfer stuck one byte from
    // the end, with no hint that the phone is done and waiting.
    const full = total > 0 && sent >= total;
    if (!full) upBytesRef.current.fullAt = 0;
    else if (!upBytesRef.current.fullAt) upBytesRef.current.fullAt = now;
    const waitS = upBytesRef.current.fullAt ? Math.round((now - upBytesRef.current.fullAt) / 1000) : 0;
    const pct = total > 0 ? (full ? 100 : Math.min(99, Math.round((sent / total) * 100))) : 0;
    const eta = total > sent ? etaText(total - sent, kbps) : null;
    setUploading(
      total <= 0
        ? `Uploading ${n}…`
        : full
          ? `Sent ${fmtSize(total)} · waiting for the host${waitS > 2 ? ` · ${waitS}s` : ""}`
          : `Uploading ${n} · ${pct}% · ${fmtSize(sent)}/${fmtSize(total)}${kbps ? ` · ${Math.round(kbps)} kB/s` : ""}${eta ? ` · ${eta}` : ""}`,
    );
    setUpProg({ sent, total, pct, kbps, waiting: full });
  }

  // ── Background image-upload buffer (session annotate flow) ───────────
  const uploadPending = uploading != null;
  // The row outlives the upload by a beat, so a batch that goes quiet between
  // two files (or a retry waiting out its backoff) doesn't resize the composer —
  // and through it the terminal — on every gap. See useLinger.
  const uploadRowLinger = useLinger(uploadPending, UPLOAD_ROW_LINGER_MS);
  // The label is normally driven by progress events — which stop the moment the
  // last byte is out, precisely when the row has something new to say ("waiting
  // for the host", and for how long). Tick it while a batch is up so that phase
  // is not a frozen string. Same string ⇒ React bails, so this costs nothing
  // during an ordinary transfer.
  useEffect(() => {
    if (!uploadPending) return;
    const t = window.setInterval(() => refreshUploadLabel(), 1000);
    return () => window.clearInterval(t);
  }, [uploadPending]);

  return {
    uploading, parking, upProg, setUploading, setUpProg, inflightRef, parkingRef, upBytesRef, allBufsRef, uploadBufRef,
    refreshUploadLabel, uploadPending, uploadRowLinger,
  };
}

export function uploadFns(c: QueueCtx): UploadFns {
  const { inflightRef, parkingRef, upBytesRef, allBufsRef, uploadBufRef, setUploading, setUpProg } = c.up;
  const refreshUploadLabel = () => c.up.refreshUploadLabel();
  const { uploadsInFlight, uploadAborts, sessionsRef, activeIdRef, composeTextRef, connRef, repos } = c;
  const active = c.getActive;
  const queueImageUpload: QueueCtx["queueImageUpload"] = (repoId, blob, filename, lane, cwd) =>
    c.queueImageUpload(repoId, blob, filename, lane, cwd);
  const removeQueued = (ackId: string) => c.removeQueued(ackId);
  const queueBacklog: QueueCtx["queueBacklog"] = (opts) => c.queueBacklog(opts);
  const submitInput: QueueCtx["submitInput"] = (id, cwd, text, kind, hold) => c.submitInput(id, cwd, text, kind, hold);
  const pushHistory = (text: string) => c.pushHistory(text);
  const setCompose = c.setCompose;

  /** Open a buffer for this repo. Reuse ONLY the current, still-OPEN batch for the
   *  same repo — a closed buffer is draining from a prior batch and finalizes itself,
   *  so merging into it would cross-contaminate repo/target/submit and settle early. */
  function ensureUploadBuf(repoId: string): UploadBuf {
    const cur = uploadBufRef.current;
    if (cur && !cur.closed && cur.repoId === repoId) return cur;
    const a = active();
    const target = a ? { id: a.id, cwd: a.cwd } : undefined;
    const buf: UploadBuf = { repoId, slots: [], started: 0, done: 0, closed: false, submit: false, queue: false, ctrl: new AbortController(), ackIds: [], target };
    allBufsRef.current.add(buf);
    return (uploadBufRef.current = buf);
  }
  /**
   * Park one image into the send queue and fill the next ordered slot of `buf`.
   *
   * Deliberately NOT a direct POST, not even with the link up. The bytes of an
   * annotated image exist NOWHERE but this tab's memory — the marked copy was
   * drawn on a canvas a second ago and the annotator sheet is already closing —
   * so every moment spent uploading it straight from RAM is a moment in which a
   * reload loses it for good. That is not hypothetical: a tunnel that drops is
   * exactly what makes `ws.ts`'s watchdog hard-reload the page, and the
   * annotate → "send & run" flow died precisely there. The prompt survived (the
   * compose draft is persisted per keystroke) while the picture it referenced
   * had never existed anywhere but this buffer, so the whole annotation had to
   * be redone.
   *
   * Parking writes the bytes to IndexedDB and the intent to the outbox BEFORE
   * anything can go wrong, and hands back the path immediately — so the prompt
   * naming it is queued (durably, in the same lane, behind the image) within
   * milliseconds of the tap. `runUpload` does the POST from there, and a reload
   * mid-transfer resumes it instead of losing it.
   */
  function queueUpload(
    buf: UploadBuf,
    src: Blob | Promise<Blob>,
    name: string,
    note?: string | Promise<string | undefined>,
    size?: { w: number; h: number },
  ) {
    const i = buf.started++;
    buf.slots[i] = null;
    inflightRef.current++;
    parkingRef.current++;
    refreshUploadLabel();
    void (async () => {
      let ref: string | null = null;
      // Where the upload is parked, and which lane holds the prompt that will
      // name it: the session these images were annotated for, else the repo
      // (`create:<cwd>`, the same lane a queued `session.create` uses).
      const repoDir = repos.find((r) => r.id === buf.repoId)?.worktreePath ?? buf.repoId;
      const lane = buf.target?.id ?? `create:${repoDir}`;
      try {
        const raw = src instanceof Blob ? src : await src;
        // Shrink BEFORE the bytes are stored — `auto` reads the link, an
        // explicit pick (annotator / Settings) overrides it. Storing the
        // original and shrinking at POST time would park megabytes we are never
        // going to send.
        const { width } = effectiveMaxWidth();
        const shrunk = await scaleForUpload(raw, name, width);
        const parked = await queueImageUpload(buf.repoId, shrunk.blob, shrunk.name, lane, buf.target?.cwd ?? repoDir);
        if (!parked) {
          buf.fail ??= "this browser can't hold files offline — reconnect and re-attach";
          showToast(buf.fail);
        }
        else {
          buf.ackIds.push(parked.ackId);
          // Settled HERE, not at the tap: a highlighted band may still have been
          // being read on the host when the sheet closed, and the shrink above is
          // the only place the grid the agent actually receives is known.
          const settled = await Promise.resolve(note);
          const dims = shrunk.width && shrunk.height ? { w: shrunk.width, h: shrunk.height } : size ?? null;
          const full = settled ? withUploadSize(settled, dims) : "";
          ref = full ? `${parked.relPath} (marked: ${full})` : parked.relPath;
        }
      } catch {
        // Decode/encode/shrink failed — there is nothing to park and nothing to
        // retry. The empty slot makes `settleUploads` report the failure.
        buf.fail ??= "couldn't read that image";
      }
      inflightRef.current = Math.max(0, inflightRef.current - 1);
      // The path exists from here on, whether or not the POST has started — so
      // the composer is free again and the QUEUE owns the ordering.
      parkingRef.current = Math.max(0, parkingRef.current - 1);
      if (buf.ctrl.signal.aborted) { refreshUploadLabel(); return; } // canceled — don't finalize
      buf.slots[i] = ref;
      buf.done++;
      refreshUploadLabel();
      settleUploads(buf);
    })();
  }
  /** Abort every live batch and drop the queue entries it parked.
   *
   *  Two halves since uploads went through the send queue: aborting the buffer
   *  stops a slot that is still being encoded/parked, and the entries already
   *  parked have to be discarded by ackId — an abort alone would leave the
   *  bytes queued and the image would arrive anyway, minutes after the user
   *  asked for it not to. In-flight POSTs are aborted through their controller;
   *  `runUpload`'s catch requeues them, and the discard below removes them. */
  function cancelUploads() {
    const ids = new Set<string>(uploadsInFlight.current);
    for (const b of allBufsRef.current) { b.ctrl.abort(); for (const id of b.ackIds) ids.add(id); }
    if (uploadBufRef.current) { uploadBufRef.current.ctrl.abort(); for (const id of uploadBufRef.current.ackIds) ids.add(id); }
    allBufsRef.current.clear();
    uploadBufRef.current = null;
    if (!ids.size && !inflightRef.current) return;
    for (const id of ids) {
      uploadAborts.current.get(id)?.abort();
      removeQueued(id);
    }
    inflightRef.current = 0;
    parkingRef.current = 0;
    upBytesRef.current = { sent: 0, total: 0, startedAt: 0, fullAt: 0 };
    setUploading(null);
    setUpProg(null);
    showToast("Uploads canceled");
  }
  /** When `buf` is CLOSED and fully uploaded, drop its refs into compose / submit —
   *  exactly once. Operates on the passed buffer, not the current one, so a batch
   *  that started after this one closed drains independently without contamination. */
  function settleUploads(buf: UploadBuf) {
    if (buf.finalized) return;
    if (buf.done < buf.started || !buf.closed) return; // still uploading, or batch still open
    buf.finalized = true;
    allBufsRef.current.delete(buf);
    if (uploadBufRef.current === buf) uploadBufRef.current = null;
    const refs = buf.slots.filter((x): x is string => !!x);
    if (!refs.length) { showToast(buf.fail ?? "Upload failed"); return; }
    const joined = refs.join(" ");
    void copyText(joined);
    // Fresh reads (not stale closures): the session the images were annotated for,
    // whether it's still the ACTIVE one, and the live compose draft.
    const sess = buf.target ? sessionsRef.current.find((s) => s.id === buf.target!.id && s.running) : null;
    const targetIsActive = !buf.target || activeIdRef.current === buf.target.id;
    const base = composeTextRef.current;
    const withDraft = base ? `${base}${base.endsWith(" ") ? "" : " "}${joined}` : joined;
    if (buf.queue && buf.target) {
      // *when it's free*, on a message that carries a picture: the desktop pins
      // it to the session the images were annotated for and types it in when
      // that session can take it. Exactly the composer's `When free` — same
      // post, same holder — so the receipt is `sendModeToast`'s sentence and
      // not a fifth wording of it.
      // Same draft rule as submit — never fold another session's draft in.
      const text = (targetIsActive ? withDraft : joined).trim();
      // `null` means REFUSED — the text names an upload that will never arrive
      // (`guardUploadRefs`, which has already said so). Clearing the box on
      // that verdict is how a prompt someone typed disappears with nothing
      // queued behind it, so the draft stays exactly where it is.
      const queued = queueBacklog({
        text, repoDir: buf.target.cwd, label: text.slice(0, 40),
        targetSessionId: sess ? buf.target.id : undefined, autoFire: true,
      });
      if (queued === null) return;
      pushHistory(text);
      if (targetIsActive) setCompose("");
      // The `+ later` screen is done once its row is posted — as its own Send.
      if (targetIsActive && isLaterId(buf.target.id)) c.setActiveId(null);
      // With no live session to pin to, the item is the REPO's and waits for a
      // session of its own — a different promise, and the only reason there are
      // two sentences here rather than one.
      showToast(sess
        ? `Attached ${refs.length} · ${sendModeToast("idle", { online: connRef.current.status === "open", holder: "desktop" })}`
        : `Attached ${refs.length} · waiting in this repo's backlog — it opens a session of its own when it runs`);
    } else if (buf.submit && sess) {
      // Include the live draft only if the annotated session is still active — else
      // submit refs alone, so we never hijack another session's draft.
      const text = targetIsActive ? withDraft : joined;
      // Same rule as the queue branch above: `false` is a refusal, and the
      // words have to survive it.
      if (!submitInput(sess.id, sess.cwd, text, text.trimStart().startsWith("/") ? "command" : "prompt")) return;
      pushHistory(text);
      if (targetIsActive) setCompose("");
      showToast(`Attached ${refs.length} · submitted`);
    } else if (targetIsActive) {
      // Safe to append to the (still-current) compose box.
      setCompose(withDraft);
      // `+ later` has no session to run in: the words wait in the box for its Send.
      showToast(buf.submit && !isLaterId(buf.target?.id) ? `Attached ${refs.length} · session gone, in box` : `Attached ${refs.length} · ready`);
    } else {
      // User switched sessions — don't touch the current draft. Refs are on the clipboard.
      showToast(`Attached ${refs.length} · copied (switched away)`);
    }
  }

  return { ensureUploadBuf, queueUpload, cancelUploads, settleUploads };
}
