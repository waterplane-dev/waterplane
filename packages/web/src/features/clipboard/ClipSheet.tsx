/**
 * The `clip` sheet: put text on the DESKTOP's clipboard, staged from the
 * compose draft, the phone's clipboard or typing. Nothing is typed into the
 * session.
 */
import { useState } from "react";
import { ClipboardPaste, CloudUpload, Eraser, Quote } from "lucide-react";
import { useCore } from "../../sdk";
import { SheetHead } from "../../Sheet";
import { api } from "../../api";
import { clipSeed } from "./store";

export function ClipSheet() {
  const core = useCore();
  const compose = core.compose.draft;
  // Seeded from the draft at the moment of the tap; the edits are this sheet's
  // own, and a fresh open re-seeds (the sheet is a fresh mount per open).
  const [clipText, setClipText] = useState(() => clipSeed.get());
  const n = clipText.length;

  /** Try to stage the PHONE's clipboard. Reading it needs a secure context, a
   *  user gesture and (on Chrome) a permission the user may refuse — every one
   *  of those fails silently as an empty read, so say which wall we hit and
   *  leave the box editable so a long-press paste still works. */
  async function pasteFromPhoneClip() {
    if (!window.isSecureContext || !navigator.clipboard?.readText) {
      core.say.toast("clipboard read needs https — long-press the box and paste");
      return;
    }
    try {
      const t = await navigator.clipboard.readText();
      if (!t) { core.say.toast("phone clipboard is empty"); return; }
      setClipText(t);
      core.say.toast(`pasted ${t.length} chars`);
    } catch {
      core.say.toast("phone clipboard unavailable — long-press the box and paste");
    }
  }
  /** Push the staged text onto the desktop host's system clipboard. */
  async function sendToHostClip(text: string) {
    if (!text.trim()) { core.say.toast("nothing to send — type or paste text first"); return; }
    try {
      const r = await api.setClipboard(text);
      if (r.ok) { core.say.toast(`sent ${r.chars ?? text.length} chars to desktop clipboard`); core.nav.close("clip"); }
      else core.say.toast(`clipboard failed: ${r.error ?? "?"}`);
    } catch {
      core.say.toast("clipboard failed");
    }
  }

  return (
    <div className="sheet">
      <SheetHead title={"To desktop clipboard"} onClose={() => core.nav.close("clip")} />
      <div className="form-hint">
        Puts text on the DESKTOP's system clipboard — nothing is typed into the session.
        Paste your phone's clipboard, pull in the compose draft, or just type below.
      </div>
      <textarea
        className="text-dump mono"
        autoFocus
        placeholder="text to put on the desktop clipboard…"
        value={clipText}
        onChange={(e) => setClipText(e.target.value)}
      />
      <div className="sheet-actions">
        <button className="key" onClick={() => void pasteFromPhoneClip()}><ClipboardPaste size={16} /> phone clipboard</button>
        {compose.trim() && compose !== clipText
          ? <button className="key" onClick={() => setClipText(compose)}><Quote size={16} /> compose draft</button>
          : null}
        {n ? <button className="key" onClick={() => setClipText("")}><Eraser size={16} /> clear</button> : null}
        <div className="spacer" />
        <button className="send" disabled={!clipText.trim()} onClick={() => void sendToHostClip(clipText)}>
          <CloudUpload size={16} /> send{n ? ` ${n}` : ""}
        </button>
      </div>
    </div>
  );
}
