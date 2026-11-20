/**
 * **The download button itself, written once.**
 *
 * `download.ts` made every download take one path; this makes every download
 * button LOOK like one button. Four screens had grown their own — the gallery
 * viewer, the files sheet, the image viewer, the build sheet — and three of
 * them re-implemented the same icon ladder while the fourth stayed permanently
 * on "download" no matter what the file's transfer was doing. A control that
 * cannot say "already downloading" is a control that gets tapped again, and two
 * transfers on a bad link both finish later than one.
 *
 * Phase, label and sentence all come from `downloadState.ts`; this file adds
 * nothing but the icon and the tap.
 */
import { CloudDownload, Download, Loader2, Smartphone } from "lucide-react";
import { downloadStatus, downloadTap } from "./download";
import { pulls, type LocalPull, type PullRecord } from "./pull";
import { useEffect, useState } from "react";
import { track } from "./usage";
import { Button } from "./kit/Button";
import { Explain } from "./Explain";

interface Props {
  /** The file, as a download target. */
  target: LocalPull;
  /** The record for it, when the caller is already subscribed to the queue
   *  (the gallery has one per row). Omit and the button subscribes itself. */
  rec?: PullRecord;
  /** Fired when the tap actually STARTS a transfer — not when it saves or opens
   *  the sheet — so a caller can mark the file as asked-for. */
  onStart?: () => void;
  /** Icon only (a sheet header, where a label does not fit). The sentence is
   *  still on the title, and the phase still shows in the icon. */
  compact?: boolean;
  className?: string;
  /** Usage counter for this button's screen. */
  trackId?: string;
  /** D8: one folded line under the button saying how a download behaves (never a card that opens by itself). */
  explain?: boolean;
}

/** Subscribe to just this file's record. One listener per mounted button; the
 *  queue notifies rarely (a flush, a state change), so this is cheap. */
export function useDownloadRecord(target: LocalPull | null): PullRecord | undefined {
  const [rec, setRec] = useState<PullRecord | undefined>();
  const { repoId, relPath, mtime } = target ?? { repoId: "", relPath: "", mtime: undefined };
  useEffect(() => {
    if (!repoId || !relPath) { setRec(undefined); return; }
    return pulls.subscribe(() => setRec(pulls.findFor(repoId, relPath, mtime)));
  }, [repoId, relPath, mtime]);
  return rec;
}

export function DownloadButton({ target, rec, onStart, compact, className, trackId, explain }: Props) {
  const own = useDownloadRecord(rec === undefined ? target : null);
  const record = rec ?? own;
  const st = downloadStatus(record);
  const icon = st.phase === "downloading" ? <Loader2 size={16} className="spin" />
    : st.phase === "queued" ? <CloudDownload size={16} />
      : st.phase === "have" || st.phase === "saved" ? <Smartphone size={16} />
        : <Download size={16} />;
  const button = (
    <Button
      className={`${st.phase === "have" || st.phase === "saved" ? "ok" : ""} ${className ?? ""}`}
      title={st.detail}
      /* No `data-hint` here (D8): the first tap used to open an explainer card instead of downloading.
         The explanation is one folded line under the button in the viewer (`GalleryViewer.tsx`). */
      onClick={() => {
        if (trackId) track(trackId);
        if (st.phase === "idle" || st.phase === "failed") onStart?.();
        downloadTap(target, record);
      }}
    >
      {icon}{compact ? null : <> {st.label}</>}
    </Button>
  );
  return explain ? (
    <>{button}<Explain of="download" label="how a download works">Waits and resumes if the link drops; lands in Downloads.</Explain></>
  ) : button;
}
