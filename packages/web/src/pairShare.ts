/**
 * What "copy" and "share" put in another app for a pairing: the link and the
 * code as text, never only the QR. Pure; `PairCopyRows.tsx` is the screen.
 * Node-tested (`pairShare.test.mjs`).
 */
import { formatPairCode, type PairMintResponse } from "@waterplane/shared";

/** A desktop with no tailnet: its one address is plain, so `landingUrl` would put the code in a
 *  request line, and the host burns a code that arrives that way. */
export function pairLanOnly(m: Pick<PairMintResponse, "base" | "lanBase">): boolean {
  return !!m.lanBase && m.lanBase === m.base;
}

/** What the QR and the copy row hold. The deep link goes camera to app and never touches the network.
 *  `overLan`: the new phone has no Tailscale, so neither the landing URL nor the deep link's `u=`
 *  reaches anything. There is no landing URL for the LAN on purpose: a plain socket burns the code. */
export function pairLinkOf(m: Pick<PairMintResponse, "base" | "lanBase" | "landingUrl" | "deepLink" | "lanDeepLink">, overLan = false): string {
  if (overLan && m.lanDeepLink) return m.lanDeepLink;
  return pairLanOnly(m) ? m.deepLink : m.landingUrl;
}

/** The share sheet's text: the link first (it carries the code), then the code. */
export function pairShareText(m: Pick<PairMintResponse, "base" | "lanBase" | "landingUrl" | "deepLink" | "lanDeepLink" | "code">, hostName: string | null, overLan = false): string {
  const who = hostName ? ` with ${hostName}` : "";
  return `Pair${who}: ${pairLinkOf(m, overLan)}\nCode: ${formatPairCode(m.code)} (works once, 10 minutes)`;
}

/** Said under the copy buttons when the clipboard API is not there. */
export const CLIPBOARD_NEEDS_HTTPS =
  "Copy only works over https here — this page is plain http. Press and hold the link or the code to select it, or use Share.";

/** True when the page may use the async clipboard (a secure context). */
export function canCopyDirectly(secure: boolean, hasClipboard: boolean): boolean {
  return secure && hasClipboard;
}
