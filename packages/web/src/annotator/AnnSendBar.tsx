/**
 * The send row: the upload-scale picker and the skip / send-all / dispatch / send verbs.
 *
 * Moved out of `ImageAnnotator.tsx` (docs/notes/charts-architecture.md); the sheet's behaviour is
 * unchanged and `ImageAnnotator.tsx` composes it.
 *
 * A region: it draws the model and owns no hook (a child's effects run before its parent's).
 */

import type { CSSProperties } from "react";
import { Hourglass, ScanText } from "lucide-react";
import { UploadScalePicker } from "../UploadScalePicker";
import type { AnnModel } from "./useAnnotator";
import { Button } from "../kit/Button";
import { annSendGrid } from "./annSendGrid";

export function AnnSendBar({ m }: { m: AnnModel }) {
  const { busy, send, sendAll, readAll } = m;
  const { index, total, onSkip, onSendAll, onDispatch, onText } = m.props;
  const many = !!(onSendAll && total && total > 1);
  const single = !!(onDispatch && (!total || total <= 1));
  const n = (onSkip ? 1 : 0) + (many ? 3 : 0) + (single ? 2 : 0) + (onText ? 1 : 0) + 1;
  const { cols, span } = annSendGrid(n); // `n` = exactly the buttons below
  return (
    <>
      {/* Last stop before the bytes go: shrink more (or less) than auto would. Sticky per device — see
          uploadScale.ts. data-primary-key: Ctrl/Cmd+Return sends this picture, then the prompt. */}
      <UploadScalePicker compact />
      <div className="sheet-actions annot-send-bar" data-primary-key=""
        style={{ "--ann-cols": cols, "--ann-send-span": span } as CSSProperties}>
        {onSkip && <Button onClick={onSkip} disabled={busy}>skip</Button>}
        {many && (
          <>
            <Button onClick={() => sendAll("none")} disabled={busy} title="send this + every remaining image as-is">Send all</Button>
            <Button onClick={() => sendAll("run")} disabled={busy} title="send all, then submit once uploads finish">Send all + submit</Button>
            {/* One WHEN, one name: the composer's words + hourglass, never "queue". */}
            <Button onClick={() => sendAll("queue")} disabled={busy} title="send all, then hand the prompt to the desktop — it goes in when this session is free"><Hourglass size={14} /> Send all, then when it&apos;s free</Button>
          </>
        )}
        {single && (
          <>
            <Button onClick={() => send("run")} disabled={busy} title="attach the image and run the prompt (uploads in the background)">Send &amp; run</Button>
            <Button onClick={() => send("queue")} disabled={busy} title="attach the image and hand the prompt to the desktop — it goes in when this session is free"><Hourglass size={14} /> Send &amp; when it&apos;s free</Button>
          </>
        )}
        {/* The picture's WORDS instead of the picture, read on the desktop
            (annOcr.ts) — for a photo with a person in it. */}
        {onText && <Button onClick={() => void readAll()} disabled={busy}
          title="read every word on the desktop and send only the text, not the photo"><ScanText size={14} /> text only</Button>}
        <button className="send" onClick={() => send("none")} disabled={busy}>
          {busy ? "Sending…" : total && total > 1 && (index ?? 1) < total ? "Send & next" : "Send to repo"}
        </button>
      </div>
    </>
  );
}
