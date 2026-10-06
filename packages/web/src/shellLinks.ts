/**
 * What the shell links bar SAYS — the pure half of `ShellLinksBar.tsx`.
 *
 * A shell session has no sign-in flow of its own: any program in it may print a
 * URL (a CLI's login page, a device-code page) or ask the desktop to open one
 * (`$BROWSER`). The host reads those off the screen and the shim and publishes
 * them as `SessionInfo.links`; this is the wording and the ordering, kept out of
 * the component so the sentences are pinned by `shellLinks.test.mjs`.
 *
 * No React, no DOM.
 */
import type { ShellLink } from "@waterplane/shared";

/** The sentence under a link a program ASKED the desktop to open — the person
 *  never typed it, so say where it came from. Screen-sourced links need no
 *  label: they are the text the person is looking at. */
export function sourceLabel(l: Pick<ShellLink, "source">): string | null {
  return l.source === "browser" ? "a program asked to open this" : null;
}

/** A `local` link points at the desktop's own localhost, which the phone cannot
 *  reach — so it is a sentence instead of an Open button. */
export const LOCAL_LINK_NOTE =
  "this link points at the desktop's own localhost — it can't be opened from the phone; use the command's no-browser / device flag (see logins)";

/** The code button's words. */
export function copyCodeLabel(code: string): string {
  return `copy code ${code}`;
}

/** Toast when the clipboard refused: say why, and show the code to type by hand. */
export function codeRefusedToast(code: string): string {
  return `clipboard needs https — type the code by hand: ${code}`;
}

/** Shown while a pasted code is wanted. */
export const AWAITING_CODE_HINT = "the program is waiting for a code — sign in, then paste code (or type it in the compose bar)";

/** Newest first: the link just printed is the one a person wants, and the host
 *  sends them oldest first. Never drops one. */
export function orderLinks(links: readonly ShellLink[]): ShellLink[] {
  return [...links].sort((a, b) => b.at - a.at);
}

/** `host/path…` — the line a collapsed row shows so two links are tellable apart. */
export function linkSummary(url: string, max = 44): string {
  let bare: string;
  try {
    const u = new URL(url);
    if (u.username || u.password) return SUSPICIOUS_LINK;
    bare = `${u.host}${u.pathname === "/" && !u.search ? "" : u.pathname}${u.search}`;
  } catch {
    bare = url.replace(/^https?:\/\//i, "");
  }
  return bare.length > max ? `${bare.slice(0, max - 1)}…` : bare;
}

/** What a link with a `user@` part reads as: `https://github.com@evil.tld/x` goes to evil.tld. */
export const SUSPICIOUS_LINK = "suspicious link (has a user@ part)";

/** Words for why such a link has no Open button. */
export const SUSPICIOUS_LINK_NOTE = "Not offered to open: the address has a user@ part, which can make a link look like one site while it goes to another. Copy it only if you know where it leads.";

/** A link whose address carries userinfo (`user:pass@`). Unparseable ⇒ false (the host only hands over http(s) URLs). */
export function hasUserinfo(url: string): boolean {
  try { const u = new URL(url); return !!(u.username || u.password); } catch { return false; }
}

/** Whether the bar is drawn at all. */
export function hasShellBar(s: { links?: readonly ShellLink[] | null; awaitingCode?: boolean }): boolean {
  return !!s.links?.length || !!s.awaitingCode;
}
