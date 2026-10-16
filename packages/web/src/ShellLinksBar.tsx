import { useState } from "react";
import { Copy, ExternalLink, Link2, ClipboardPaste, ChevronDown, ChevronUp, BookKey } from "lucide-react";
import type { ShellLink } from "@waterplane/shared";
import { ago } from "./format";
import { Stowable, StowButton } from "./Stowable";
import {
  AWAITING_CODE_HINT, LOCAL_LINK_NOTE, SUSPICIOUS_LINK_NOTE, copyCodeLabel, hasUserinfo, linkSummary, orderLinks, sourceLabel,
} from "./shellLinks";

/**
 * Links a program in a SHELL session printed or asked to open — the shell's
 * counterpart of `LoginBar`, which stays claude's.
 *
 * Same three verbs, in the order a login needs them: open (the phone's browser,
 * `openLink` → `openExternal`), copy the link, and — when the host saw a code
 * printed beside the link — a prominent copy-code button, because the page
 * usually asks for it and a device code is typed on the phone. The clipboard
 * needs a secure context; on refusal `onCopyCode` resolves false and the code is
 * shown large so it can be typed by hand. `paste code` is the reverse trip and
 * is offered only while the screen is visibly waiting for one (`awaitingCode`),
 * because elsewhere the same keystrokes would land in the shell as a command.
 *
 * A `local` link points at the DESKTOP's localhost: no Open button, a sentence.
 * The URL text sits under a disclosure — the last resort when every automatic
 * path fails — exactly as in `LoginBar`.
 */
export function ShellLinksBar({ links, awaitingCode, onOpen, onCopy, onCopyCode, onPasteCode, onLogins }: {
  links: readonly ShellLink[];
  awaitingCode: boolean;
  onOpen: (url: string) => void;
  onCopy: (url: string) => void;
  /** Resolves false when the clipboard refused. */
  onCopyCode: (code: string) => Promise<boolean>;
  onPasteCode: () => void;
  onLogins: () => void;
}) {
  const [shown, setShown] = useState<string | null>(null);
  const [typeBy, setTypeBy] = useState<string | null>(null);
  const rows = orderLinks(links);
  const title = rows.length > 1 ? "links from the shell" : "link from the shell";
  // Folded for exactly these links and codes: a new one, or the shell starting
  // to wait for a code, is something to read and comes back up by itself.
  const stowKey = [awaitingCode ? "await" : "", ...rows.map((l) => `${l.url} ${l.code ?? ""}`)].join("\n");
  const code = rows.find((l) => l.code)?.code;
  return (
    <Stowable slot="shell-links" stowKey={stowKey} label={title} detail={code} icon={Link2}>
    <div className="approve login shell-links">
      <div className="login-head">
        <span className="login-title"><Link2 size={14} /> {title}</span>
        <button className="approve-esc" onClick={onLogins}><BookKey size={12} /> logins</button>
        <StowButton />
      </div>
      {rows.map((l) => {
        const label = sourceLabel(l);
        const odd = !l.local && hasUserinfo(l.url);
        return (
          <div key={l.url} className="shell-link">
            <div className="approve-hint">
              <span className="mono">{linkSummary(l.url)}</span> · <span title="when the shell printed this link">{ago(l.at)}</span>
              {label && <> · {label}</>}
            </div>
            {l.local ? (
              <div className="approve-hint">{LOCAL_LINK_NOTE}</div>
            ) : (
              <div className="approve-opts">
                {odd ? (
                  <div className="approve-hint">{SUSPICIOUS_LINK_NOTE}</div>
                ) : (
                  <button className="approve-btn primary" onClick={() => onOpen(l.url)}>
                    <ExternalLink size={14} /> Open
                  </button>
                )}
                <button className="approve-btn" onClick={() => onCopy(l.url)}>
                  <Copy size={14} /> copy link
                </button>
                {l.code && (
                  <button className="approve-btn primary shell-code-btn" onClick={() => {
                    const code = l.code!;
                    void onCopyCode(code).then((ok) => setTypeBy(ok ? null : code));
                  }}>
                    <Copy size={14} /> {copyCodeLabel(l.code)}
                  </button>
                )}
                <button className="approve-esc" onClick={() => setShown(shown === l.url ? null : l.url)}>
                  {shown === l.url ? <ChevronUp size={12} /> : <ChevronDown size={12} />} url
                </button>
              </div>
            )}
            {!l.local && l.code && typeBy === l.code && <div className="shell-code-big mono">{l.code}</div>}
            {shown === l.url && <div className="login-url mono">{l.url}</div>}
          </div>
        );
      })}
      {awaitingCode && (
        <>
          <div className="approve-opts">
            <button className="approve-btn" onClick={onPasteCode}>
              <ClipboardPaste size={14} /> paste code
            </button>
          </div>
          <div className="approve-hint">{AWAITING_CODE_HINT}</div>
        </>
      )}
    </div>
    </Stowable>
  );
}
