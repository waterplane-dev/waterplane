import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CircleHelp, CloudUpload, FileText, ImageOff, Paperclip, RotateCw, Trash2, X } from "lucide-react";
import { sendingUploadsKey, type AttachStatus } from "@waterplane/shared";
import { api } from "./api";
import { attachLabel, checkAttachments, localPreview, requestAttachOpen } from "./attachments";
import { useFileMtime } from "./fileMtime";
import { pickThumbWidth, sized } from "./media";
import { cacheThumb } from "./thumbCache";
import { useThumbSrc } from "./thumbSrc";
import type { OutboxEntry } from "./outbox";
import type { FileRef } from "./fileRefs";
import { Button } from "./kit/Button";

/** CSS width of a strip thumbnail. Same reasoning as the reader's inline one:
 *  small enough to sit under a queue row, big enough to tell WHICH screenshot. */
const THUMB_CSS = 96;

interface Props {
  /** The prompt whose file mentions are being shown. */
  text: string;
  /** Repo the paths are relative to — null when the text has no target yet (a
   *  pad note), in which case nothing can be looked up on the host. */
  repoId: string | null;
  /** The live send queue: what it holds decides `sending`. */
  outbox: OutboxEntry[];
  online: boolean;
  /** Re-check when this changes — a re-attach or an upload landing has to be
   *  visible without closing the sheet. */
  nonce?: number;
  /** Report the verdict upwards, so a Send button can be gated on it. */
  onStates?: (states: AttachStatus[]) => void;
  /** Offered per file that is not going to arrive: put the phone's copy back in
   *  the queue, pick a different file, or take the mention out of the text.
   *  Omitted in read-only places (a queue row), where the strip only shows. */
  onReattach?: (relPath: string) => void;
  onReplace?: (relPath: string) => void;
  onForget?: (relPath: string) => void;
  /** The X in each tile's corner: take this file out of the prompt being
   *  written. Only where the text is still editable (the compose bar, the pad
   *  editor, the send sheet); a queue row never gets one. The bytes are not
   *  touched — an upload already queued still lands in the inbox, where the
   *  sweep finds it like any other file nobody named. */
  onRemove?: (relPath: string) => void;
  /** Compact = thumbnails and one status line, no per-file actions and no
   *  heading. What a queue or pad row wants. */
  compact?: boolean;
  /**
   * Wait this long after the text settles before checking.
   *
   * For a live compose box: every keystroke would otherwise be a repo listing.
   * Zero (the default) is right everywhere the text is fixed — a queue row, a
   * pad note, the resend editor between edits.
   */
  debounceMs?: number;
}

const ICON: Record<AttachStatus["state"], typeof Paperclip> = {
  host: Paperclip,
  sending: CloudUpload,
  kept: RotateCw,
  dead: AlertTriangle,
  missing: ImageOff,
  unknown: CircleHelp,
};

/**
 * One file's picture, and the tap that opens it.
 *
 * Two sources, in this order. The phone's own bytes win when they exist: they
 * are the only copy while an upload is queued or after one has died, and they
 * need no link. Otherwise the host's copy is drawn the way every other picture
 * in this app is drawn — a MTIME-VERSIONED thumbnail resolved cache-first
 * (`thumbSrc.ts`) and remembered once it loads — which is what makes a queue row
 * still show its screenshot with the tunnel down. An un-versioned URL, which is
 * what this strip used to build, is cacheable by nobody: one request per row per
 * session, over exactly the link the row is complaining about.
 *
 * Tapping is the point of the picture. A 64px thumb tells you WHICH screenshot;
 * it does not tell you what is in it, and the file is otherwise reachable only
 * by finding it in the gallery — if it is on the host at all, which for a
 * `kept`/`dead` row it is not. So anything showable opens the full-screen
 * viewer, and so does a host file with no thumbnail (a video, a document): the
 * verdict below already says what it is, the tap says what it holds.
 */
function AttachThumb({ fref: r, state: s, repoId, localSrc }: {
  fref: FileRef; state: AttachStatus; repoId: string | null; localSrc?: string;
}) {
  const [broken, setBroken] = useState(false);
  // The repo only counts once the file is actually IN it: asking the host for
  // the mtime of a `kept`/`dead` path is one 404 per row for a file whose whole
  // problem is that it never arrived.
  const hostRepo = s.state === "host" ? repoId : null;
  const mtime = useFileMtime(hostRepo, r.relPath);
  const hostUrl = !localSrc && r.image && !broken && hostRepo
    ? sized(api.artifactUrl(hostRepo, r.relPath), pickThumbWidth(THUMB_CSS), mtime)
    : null;
  const { src: hostSrc, live } = useThumbSrc(hostUrl);
  const src = localSrc ?? hostSrc;
  // Openable without a picture: a video or a document the host holds. The
  // viewer/tab knows what to do with it; the strip only has to not swallow it.
  const openable = !!src || (!!hostRepo && !r.image);
  const body = src
    ? <img
        src={src}
        alt={r.name}
        loading="lazy"
        // It drew, so the bytes are in the browser's own cache and (with `v`)
        // the host marked them immutable — remembering them is a local read.
        onLoad={() => { if (hostUrl && live && mtime) cacheThumb(hostUrl); }}
        onError={() => setBroken(true)}
      />
    : <span className="attach-noimg"><FileText size={16} /></span>;
  if (!openable) return <div className="attach-thumb">{body}</div>;
  return (
    <button
      type="button"
      className="attach-thumb tap"
      title={`${r.relPath} — tap to open`}
      onClick={() => requestAttachOpen({ relPath: r.relPath, repoId, state: s.state })}
    >{body}</button>
  );
}

/**
 * The files a prompt names, shown as the files they are.
 *
 * A path like `.claude/inbox/1000074539-mtjv8u52a489a0.jpg` is unreadable by
 * design — it is minted to never collide, not to be recognised — so a queue full
 * of them is a queue you cannot audit: "which of these three is the screenshot of
 * the crash?" has no answer without sending them and looking. This draws each one
 * from whichever copy exists (the phone's own bytes first: they need no link and
 * they are the only copy while the upload is still queued) and says, in a
 * sentence, whether it is actually going to be there.
 *
 * The states come from `@waterplane/shared`'s pure decision (`e2e-attach.mjs` pins it);
 * everything here is presentation and the three buttons that change a verdict.
 */
export function AttachStrip({ text, repoId, outbox, online, nonce, onStates, onReattach, onReplace, onForget, onRemove, compact, debounceMs = 0 }: Props) {
  // The text actually checked against. Settles behind the typed one so a compose
  // box does not turn every keystroke into an HTTP listing.
  const [settled, setSettled] = useState(text);
  useEffect(() => {
    if (!debounceMs) { setSettled(text); return; }
    const t = window.setTimeout(() => setSettled(text), debounceMs);
    return () => window.clearTimeout(t);
  }, [text, debounceMs]);
  const [rows, setRows] = useState<{ ref: FileRef; state: AttachStatus }[]>([]);
  // Object URLs minted for local bytes. Revoked as a set on every re-check and
  // on unmount — a queue of twenty rows would otherwise pin twenty photos in
  // memory for the life of the tab.
  const urls = useRef<string[]>([]);
  const [srcs, setSrcs] = useState<Record<string, string>>({});

  const sendingKey = sendingUploadsKey(outbox);
  useEffect(() => {
    let dead = false;
    void (async () => {
      const { refs, states } = await checkAttachments(settled, repoId, outbox, online);
      if (dead) return;
      setRows(refs.map((r, i) => ({ ref: r, state: states[i] })));
      onStates?.(states);
      // Only the LOCAL copies are resolved here: the host's are a versioned URL
      // a row resolves for itself, cache-first, in `AttachThumb`.
      const next: Record<string, string> = {};
      const minted: string[] = [];
      for (let i = 0; i < refs.length; i++) {
        if (!refs[i].image) continue;
        const url = await localPreview(refs[i].relPath, states[i].state, outbox);
        if (!url) continue;
        next[refs[i].relPath] = url;
        minted.push(url);
      }
      if (dead) { minted.forEach((u) => URL.revokeObjectURL(u)); return; }
      urls.current.forEach((u) => URL.revokeObjectURL(u));
      urls.current = minted;
      setSrcs(next);
    })();
    return () => { dead = true; };
    // `outbox` itself is not a dependency: it re-identifies on every queue write
    // (a progress tick, another lane's ack) and re-running the host listing on
    // each would turn a visible sheet into a poller. `sendingKey` is the one
    // queue fact the verdict reads — it moves when an upload is queued, lands or
    // dies — and `nonce` is how a caller asks for a fresh look.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `outbox` is read only through `sendingKey`
  }, [settled, repoId, online, nonce, sendingKey]);

  useEffect(() => () => { urls.current.forEach((u) => URL.revokeObjectURL(u)); }, []);

  if (!rows.length) return null;
  return (
    <div className={`attach-strip ${compact ? "compact" : ""}`}>
      {rows.map(({ ref: r, state: s }) => {
        const Icon = ICON[s.state];
        const src: string | undefined = srcs[r.relPath];
        const bad = s.state !== "host" && s.state !== "sending";
        const drop = onRemove ? () => {
          // Off the screen now, not after the debounce re-check: the tap has to
          // answer, and the text it came from has already lost the path.
          setRows((cur) => cur.filter((x) => x.ref.relPath !== r.relPath));
          onRemove(r.relPath);
        } : null;
        return (
          <div key={r.relPath} className={`attach-item ${s.state}`}>
            <AttachThumb fref={r} state={s} repoId={repoId} localSrc={src} />
            <div className="attach-body">
              <span className="attach-name" title={r.relPath}>{r.name}</span>
              <span className="attach-state"><Icon size={11} /> {attachLabel(s)}</span>
              {!compact && bad && (
                <div className="attach-acts">
                  {s.state === "kept" && onReattach && (
                    <Button title="put this phone's copy back in the send queue, under the same path — the message needs no change"
                      onClick={() => onReattach(r.relPath)}><RotateCw size={14} /> re-attach</Button>
                  )}
                  {onReplace && (
                    <Button title="pick a different file for this mention — the path in the message is rewritten to the new one"
                      onClick={() => onReplace(r.relPath)}><Paperclip size={14} /> pick a file</Button>
                  )}
                  {onForget && (
                    <Button variant="danger" title="take this mention out of the message and send the words without it"
                      onClick={() => onForget(r.relPath)}><Trash2 size={14} /> drop mention</Button>
                  )}
                </div>
              )}
            </div>
            {drop && (
              <button type="button" className="attach-x" aria-label={`remove ${r.name} from the prompt`}
                onPointerDown={(e) => e.preventDefault()} onClick={drop}><X size={16} /></button>
            )}
          </div>
        );
      })}
    </div>
  );
}
