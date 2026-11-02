import { useState, type ReactNode } from "react";
import { Copy, ExternalLink, ClipboardPaste, ChevronDown, ChevronUp } from "lucide-react";

/**
 * The link widget a sign-in card is made of — ONE component for the claude
 * session's sign-in link (`BlockBar`'s auth card) and a shell session's links
 * (`ShellLinksBar`), which differ in their data and wording but not in what a
 * person does with a link on a phone.
 *
 * The verbs, in the order a login needs them:
 *
 *  - **open** — hand it to the phone's browser (`openExternal`, which is not
 *    `window.open` in the APK; see that file). Replaced by `openNote` (a
 *    sentence) for a link that must not be offered to open.
 *  - **copy link** — the fallback for a phone whose browser choice is not the
 *    one the intent picks, and the only one that works with no browser at all.
 *  - **copy code** (`code`) — a device code is typed on the phone, so the page
 *    usually asks for it; shell links carry one.
 *  - **paste code** (`onPasteCode`) — the reverse trip, offered only while the
 *    CLI is visibly waiting for it, because outside that window the same
 *    keystrokes land in the composer as a prompt.
 *  - **url** — a disclosure holding the URL in one piece: every automatic path
 *    can fail (a blocked popup, a clipboard that needs https, a browser that
 *    refuses the intent) and the last resort has to be the text itself.
 *
 * `children` sit between the buttons and the disclosed URL (a hint, a big code).
 */
export function LinkActions({ url, openLabel, onOpen, onCopy, openNote, code, onPasteCode, children }: {
  url: string;
  openLabel: string;
  onOpen: (url: string) => void;
  onCopy: (url: string) => void;
  /** Instead of the open button: why this link is not offered to open. */
  openNote?: string;
  code?: { label: string; onCopy: () => void };
  onPasteCode?: () => void;
  children?: ReactNode;
}) {
  const [showUrl, setShowUrl] = useState(false);
  return (
    <>
      <div className="approve-opts">
        {openNote ? (
          <div className="approve-hint">{openNote}</div>
        ) : (
          <button className="approve-btn primary" onClick={() => onOpen(url)}>
            <ExternalLink size={14} /> {openLabel}
          </button>
        )}
        <button className="approve-btn" onClick={() => onCopy(url)}>
          <Copy size={14} /> copy link
        </button>
        {code && (
          <button className="approve-btn primary shell-code-btn" onClick={code.onCopy}>
            <Copy size={14} /> {code.label}
          </button>
        )}
        {onPasteCode && <PasteCodeButton onPasteCode={onPasteCode} />}
        <button className="approve-esc" onClick={() => setShowUrl((v) => !v)}>
          {showUrl ? <ChevronUp size={12} /> : <ChevronDown size={12} />} url
        </button>
      </div>
      {children}
      {showUrl && <div className="login-url mono">{url}</div>}
    </>
  );
}

/** *paste code*: read the clipboard and type it into the session (raw path). */
export function PasteCodeButton({ onPasteCode }: { onPasteCode: () => void }) {
  return (
    <button className="approve-btn" onClick={onPasteCode}>
      <ClipboardPaste size={14} /> paste code
    </button>
  );
}
