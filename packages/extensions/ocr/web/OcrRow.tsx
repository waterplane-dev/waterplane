/**
 * The text-in-marks row in Settings › Tools & diagnostics: what the reader is doing on THIS phone —
 * downloading (file n of N and the megabytes), ready (languages, size, offline), or the error with
 * a retry — and, once switched off, the offer to delete what is still downloaded (a two-tap
 * `ConfirmButton`, never `window.confirm`). The switch itself is the plugins row's.
 */
import { AlertTriangle, CheckCircle2, Download, Loader2, RotateCw, ScanText, Trash2 } from "lucide-react";
import { useExtensionEnabled, useStore } from "@waterplane/sdk";
import { Button, ConfirmButton, Hint, SetCustom, SetNote } from "@waterplane/kit";
import { ensure, forget, ocrState } from "./assets.ts";
import { keptLine, mb, OCR_ID, OFF_LINE } from "./logic.ts";

export function OcrRow() {
  const s = useStore(ocrState);
  const on = useExtensionEnabled(OCR_ID);
  return (
    <SetCustom id="ocr-reader" label="text in marks" icon={ScanText}>
      {on && s.k === "checking" && <SetNote><Loader2 size={12} /> Checking the reader on this phone…</SetNote>}
      {on && s.k === "downloading" && <SetNote><Download size={12} /> {s.line}</SetNote>}
      {on && s.k === "ready" && <SetNote><CheckCircle2 size={12} /> {s.line}</SetNote>}
      {on && s.k === "error" && (
        <>
          <Hint tone="warn"><AlertTriangle size={12} /> {s.error}</Hint>
          <Button onClick={() => { void ensure(); }}><RotateCw size={14} /> try again</Button>
        </>
      )}
      {/* Switched on, but the boot watcher has not run yet (the list just arrived). */}
      {on && s.k === "off" && <SetNote><Loader2 size={12} /> Starting…</SetNote>}
      {!on && s.k === "off" && s.kept ? (
        <>
          <SetNote>{keptLine(s.kept)}</SetNote>
          <ConfirmButton confirm={`delete ${mb(s.kept)} MB?`} onConfirm={() => { void forget(); }}>
            <Trash2 size={14} /> delete download
          </ConfirmButton>
        </>
      ) : null}
      {!on && (s.k !== "off" || !s.kept) && <SetNote>{OFF_LINE}</SetNote>}
    </SetCustom>
  );
}
