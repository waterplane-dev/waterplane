import { useState } from "react";
import { formatPairCode, type PairMintResponse } from "@waterplane/shared";
import { Check, Copy, Share2 } from "lucide-react";
import { copyText } from "./api";
import { CLIPBOARD_NEEDS_HTTPS, canCopyDirectly, pairShareText } from "./pairShare";
import { showToast } from "./toast";
import { Button } from "./kit/Button";

/**
 * The pairing as TEXT, under the QR: the link and the code, each selectable and
 * each with a Copy button, plus a Share button where Android's share sheet is
 * there. A QR can only be scanned by a camera, and the phone being added is
 * often the one holding this screen — or the desktop is a headless box and
 * the link has to travel by message.
 *
 * Nothing is greyed: Share is simply not drawn without `navigator.share`, and a
 * page that cannot use the clipboard says so in a sentence (`copyText` still
 * tries the old path, which often works over plain http).
 */
const ICON = 14;
const SELECTABLE = { userSelect: "text", WebkitUserSelect: "text", overflowWrap: "anywhere" } as const;

export function PairCopyRows({ m, hostName }: { m: PairMintResponse; hostName: string | null }) {
  const [done, setDone] = useState<"link" | "code" | null>(null);
  const [failed, setFailed] = useState(false);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const direct = canCopyDirectly(typeof window !== "undefined" && window.isSecureContext, typeof navigator !== "undefined" && !!navigator.clipboard);

  async function copy(what: "link" | "code", text: string): Promise<void> {
    const ok = await copyText(text);
    setFailed(!ok);
    setDone(ok ? what : null);
    if (ok) setTimeout(() => setDone((d) => (d === what ? null : d)), 2000);
  }

  async function share(): Promise<void> {
    try { await navigator.share({ title: "Pair a phone", text: pairShareText(m, hostName) }); }
    catch (e) { if ((e as Error)?.name !== "AbortError") showToast("could not open the share sheet"); }
  }

  return (
    <div className="pair-copy">
      <div className="pair-copy-label">Link</div>
      <div className="pair-copy-row">
        <code style={SELECTABLE}>{m.landingUrl}</code>
        <Button onClick={() => void copy("link", m.landingUrl)}>
          {done === "link" ? <Check size={ICON} /> : <Copy size={ICON} />} {done === "link" ? "copied" : "copy link"}
        </Button>
      </div>
      <div className="pair-copy-label">Code</div>
      <div className="pair-copy-row">
        <code style={SELECTABLE}>{formatPairCode(m.code)}</code>
        <Button onClick={() => void copy("code", formatPairCode(m.code))}>
          {done === "code" ? <Check size={ICON} /> : <Copy size={ICON} />} {done === "code" ? "copied" : "copy code"}
        </Button>
      </div>
      {canShare && (
        <Button className="pair-wide" style={{ marginTop: 12 }} onClick={() => void share()}><Share2 size={ICON} /> share link and code</Button>
      )}
      {(failed || !direct) && <div className="set-note" style={{ marginTop: 6 }}>{failed ? "The phone refused to copy. " : ""}{CLIPBOARD_NEEDS_HTTPS}</div>}
    </div>
  );
}
