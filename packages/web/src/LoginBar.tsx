import { useState } from "react";
import { Copy, ExternalLink, KeyRound, ClipboardPaste, ChevronDown, ChevronUp } from "lucide-react";
import type { SessionLogin } from "@waterplane/shared";
import { ago } from "./format";

/**
 * Signing in, from a phone.
 *
 * `/login` is the one flow in this app that cannot be finished inside it: the
 * CLI prints an OAuth URL, a browser has to visit it, and the code it hands
 * back has to get into the CLI's own input. Every one of those steps was
 * hostile on a terminal 53 columns wide — the URL is 300+ characters, so the
 * GRID breaks it across six rows with nothing marking them as one string, which
 * makes it untappable, unselectable and (base64, no word breaks) untypeable.
 * The honest advice used to be "go to the desk".
 *
 * The host rejoins the link and publishes it (`host/login.ts`); this is the
 * button. Three actions, in the order the flow needs them:
 *
 *  - **open** — hand it to the phone's browser (`openExternal`, which is not
 *    `window.open` in the APK; see that file).
 *  - **copy** — the fallback for a phone whose browser choice is not the one
 *    the intent picks, and the only one that works with no browser at all.
 *  - **paste code** — read the clipboard and type it into the session. Offered
 *    only while the CLI is visibly waiting for it, because outside that window
 *    the same keystrokes land in the composer as a prompt.
 *
 * The URL itself stays visible, wrapping and selectable, under a disclosure:
 * every automatic path here can fail (a blocked popup, a clipboard that needs
 * https, a browser that refuses the intent) and the last resort has to be the
 * text itself, in one piece.
 */
export function LoginBar({ login, onOpen, onCopy, onPasteCode }: {
  login: SessionLogin;
  onOpen: (url: string) => void;
  onCopy: (url: string) => void;
  onPasteCode: () => void;
}) {
  const [showUrl, setShowUrl] = useState(false);
  return (
    <div className="approve login">
      <div className="login-head">
        <span className="login-title"><KeyRound size={14} /> sign-in link</span>
        {/* A login URL expires. "Nine minutes ago" is the difference between a
            page that signs you in and one that refuses for no stated reason. */}
        <span className="login-age" title="when the CLI printed this link">{ago(login.at)}</span>
      </div>
      <div className="approve-opts">
        <button className="approve-btn primary" onClick={() => onOpen(login.url)}>
          <ExternalLink size={14} /> Open sign-in page
        </button>
        <button className="approve-btn" onClick={() => onCopy(login.url)}>
          <Copy size={14} /> copy link
        </button>
        {login.awaitingCode && (
          <button className="approve-btn" onClick={onPasteCode}>
            <ClipboardPaste size={14} /> paste code
          </button>
        )}
        <button className="approve-esc" onClick={() => setShowUrl((v) => !v)}>
          {showUrl ? <ChevronUp size={12} /> : <ChevronDown size={12} />} url
        </button>
      </div>
      {login.awaitingCode && (
        <div className="approve-hint">
          the CLI is waiting for the code — sign in, then <b>paste code</b> (or type it in the compose bar)
        </div>
      )}
      {showUrl && <div className="login-url mono">{login.url}</div>}
    </div>
  );
}
