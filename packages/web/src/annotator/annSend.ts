/**
 * Flattening the marked picture and sending it: the PNG, its note, the inline and the dispatched flows.
 *
 * Moved out of `ImageAnnotator.tsx` (docs/notes/charts-architecture.md); the sheet's behaviour is
 * unchanged and `ImageAnnotator.tsx` composes it.
 */

import { markNote, withUploadSize } from "../annNote";
import { api } from "../api";
import { track } from "../usage";
import { encodeCanvas } from "../uploadScale";
import { rememberMtime } from "../fileMtime";
import { READ_WAIT_MS, sourceName, type AnnCtx, type AnnDispatch, type AnnSend } from "./annTypes";

export function sendActions(c: AnnCtx) {
  const { source, repoId, facts, onUploaded, onDispatch, onPark, onSendAll, canvasRef, shapes, shapesRef, busy, setBusy, setErr, readsRef, readTextRef, redraw } = c;

  /** Flatten the annotated canvas to a PNG blob + a name/note describing it.
   *  The name/note are derived SYNCHRONOUSLY; only the encode is async, and
   *  `canvas.toBlob` snapshots the bitmap at call time — so the returned promise
   *  is safe to hand off and keep encoding after this sheet is gone. */
  function flattenAsync(): AnnDispatch {
    const canvas = canvasRef.current!;
    // Repaint WITHOUT the selection chrome first: `toBlob` snapshots this very
    // canvas, so a dashed selection box would ship inside the uploaded PNG.
    redraw(true);
    const annotated = shapes.length > 0;
    // `encodeCanvas`, never a bare `toBlob`: under memory pressure an Android
    // WebView's `toBlob` can hand back null, hand back an empty blob, or never
    // call its callback at all — and the third one leaves this promise pending
    // for ever, so the send that awaits it parks on "Sending…" with nothing to
    // report. The shared encoder bounds it and falls back to `toDataURL`, which
    // fails independently. PNG on purpose: these are marks drawn over a
    // screenshot, and `scaleForUpload` re-encodes on the way up anyway.
    const blob: Promise<Blob> = encodeCanvas(canvas, "image/png").then((b) => {
      if (!b) throw new Error("this device could not encode the marked-up image");
      return b;
    });
    const raw = sourceName(source);
    const base = raw.replace(/\.[^.]+$/, "").replace(/[/\\]/g, "_") || "image";
    const name = annotated ? `${base}-marked.png` : `${base}.png`;
    return { blob, name, note: noteFor(canvas.width, canvas.height), size: { w: canvas.width, h: canvas.height } };
  }

  /**
   * The clause that rides beside the path, resolved as late as it can be.
   *
   * The marks are SNAPSHOTTED here and the words merged in afterwards, because
   * both ends of this move: the sheet may advance to the next image of a batch
   * (clearing `shapes`) while a band is still being read, and the read answers
   * into a map keyed by mark id precisely so the snapshot can still collect it.
   *
   * A string whenever nothing is outstanding — the common case, and the one the
   * synchronous hand-off was built for.
   */
  function noteFor(w: number, h: number): string | Promise<string | undefined> | undefined {
    const snap = shapesRef.current.map((s) => ({ ...s }));
    const build = () => markNote(snap.map((m) => ({ ...m, read: readTextRef.current.get(m.id) ?? m.read })), w, h, facts) || undefined;
    const pending = [...readsRef.current.values()];
    if (!pending.length) return build();
    return Promise.race([
      Promise.allSettled(pending),
      new Promise((r) => setTimeout(r, READ_WAIT_MS)),
    ]).then(build);
  }

  /**
   * Inline flows (no parent dispatch) still need the encoded blob here.
   *
   * The NOTE is deliberately left unsettled: parking the bytes is the step that
   * must not wait for anything (up to this line the marks exist only as canvas
   * state in one tab), and a band still being read would otherwise hold the
   * picture in RAM for seconds — the exact window a dropped tunnel turns into a
   * lost annotation. The caller settles it after the bytes are safe.
   */
  async function flatten(): Promise<AnnDispatch & { blob: Blob }> {
    const cur = flattenAsync();
    return { ...cur, blob: await cur.blob };
  }

  /** Send this image. Session flow (`onDispatch`) hands off SYNCHRONOUSLY — the PNG
   *  encode rides along as a promise — so this sheet closes (or advances to the next
   *  image) on the same tap and the compose box is typeable while the upload runs.
   *  Awaiting the encode here is what used to park the sheet on "Sending…" for
   *  seconds on a phone-sized screenshot. Other flows await the upload inline.
   *  `mode` (session flow) runs or queues the compose text once the batch's uploads land. */
  async function send(mode: AnnSend = "none") {
    if (!canvasRef.current || busy) return;
    track(mode === "queue" ? "action:image.queue" : "action:image.send");
    setErr(null);
    if (onDispatch) {
      setBusy(true); // no await before the hand-off, so a double-tap can't dispatch twice
      onDispatch(flattenAsync(), mode);
      return; // parent uploads in the background + advances (source effect resets busy) or closes
    }
    setBusy(true);
    try {
      const { blob, name, note: raw, size } = await flatten();
      // Settled only where it is needed — after the bytes are parked below.
      // This path uploads the flattened PNG as it is (no re-encode: the queue
      // shrinks only what IT parks), so the canvas the marks were drawn on IS
      // the grid the agent receives, and the percentages can be converted.
      const settle = async () => {
        const n = await Promise.resolve(raw);
        return n ? withUploadSize(n, size ?? null) : undefined;
      };
      // Park it — always, not just offline. Up to this line the marks exist only
      // as canvas state in one tab, so an upload straight from here is a window
      // in which a dropped tunnel (or the reload its watchdog fires) costs the
      // whole annotation. Parking writes the bytes to IndexedDB and hands back
      // the path they WILL land at; the send queue does the POST, and nothing
      // about the picture depends on when it actually goes up.
      if (onPark) {
        const parked = await onPark(blob, name);
        if (parked) { onUploaded(parked, await settle()); return; }
        // Bytes could not be persisted (IndexedDB unavailable) — fall through to
        // the direct POST rather than pretending the image is on its way.
      }
      try {
        const r = await api.uploadInbox(repoId, blob, name);
        // Same receipt, same reason as the queued path in App.tsx: the mtime is
        // what lets the marked image's own thumbnail be cached (fileMtime.ts).
        if (r.saved?.[0]) rememberMtime(repoId, r.saved[0].relPath, r.saved[0].mtime);
        if (r.saved?.[0]) onUploaded(r.saved[0].relPath, await settle());
        else setErr(r.skipped?.[0]?.error || "upload failed");
      } catch (e) {
        // The tunnel dropped mid-upload — same rescue as above rather than
        // making the user re-mark the screenshot.
        const parked = onPark ? await onPark(blob, name) : null;
        if (parked) onUploaded(parked, await settle());
        else setErr(String(e));
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Batch: hand the current flattened image to the parent, which uploads it +
   *  every remaining one raw (and runs/queues per `mode`). Parent closes this sheet. */
  function sendAll(mode: AnnSend) {
    if (!canvasRef.current || !onSendAll || busy) return;
    track(mode === "queue" ? "action:image.queue" : "action:image.send");
    setBusy(true);
    setErr(null);
    onSendAll(flattenAsync(), mode); // same synchronous hand-off as `send`
  }

  return { send, sendAll };
}
