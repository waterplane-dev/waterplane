/**
 * What "copy" and "share" put in another app for a pairing: the landing link
 * and the code as text, never only the QR. Pure; `PairCopyRows.tsx` is the
 * screen. Node-tested (`pairShare.test.mjs`).
 */
import { formatPairCode, type PairMintResponse } from "@waterplane/shared";

/** The share sheet's text: the link first (it carries the code), then the code. */
export function pairShareText(m: Pick<PairMintResponse, "landingUrl" | "code">, hostName: string | null): string {
  const who = hostName ? ` with ${hostName}` : "";
  return `Pair${who}: ${m.landingUrl}\nCode: ${formatPairCode(m.code)} (works once, 10 minutes)`;
}

/** Said under the copy buttons when the clipboard API is not there. */
export const CLIPBOARD_NEEDS_HTTPS =
  "Copy only works over https here — this page is plain http. Press and hold the link or the code to select it, or use Share.";

/** True when the page may use the async clipboard (a secure context). */
export function canCopyDirectly(secure: boolean, hasClipboard: boolean): boolean {
  return secure && hasClipboard;
}
