import { isHostId, wsUrlFor, type SavedHost } from "@waterplane/shared";
import { bearerForSaved } from "./deviceToken.ts";
import { dialBaseOf } from "./hostUrl.ts";

/**
 * Which desktops the APK's background link watches — the pure half of `shellLink.ts`.
 *
 * One link per saved desktop, not only the one in use: a card raised by a desktop this phone is
 * not switched to (a vault approval above all) must reach the shade with the app swiped away, and
 * past Chromium's five-minute freeze only the native service can say anything
 * (`ShellLinkService`). The ACTIVE desktop is FIRST — the shell keeps it as its legacy single
 * address (`savedUrl`, the paired-host check, auto-downloads, the queue backlog alert).
 *
 * Always the SAVED base, never a LAN route: the service outlives the Wi-Fi a LAN route was verified
 * on. A LAN-only row with a pin this shell enforces is its TLS address (`dialBaseOf`), or the
 * service would find it unprotected and refuse it (`ShellRoute.mayDial`). The label is the person's
 * own name for the desktop, the word the alert title starts with. The demo row is not a desktop (the
 * caller passes `realHosts`).
 */
export interface ShellLinkSpec {
  hostId: string; url: string; label: string;
  /** That desktop's OWN device token, for a password-gated (`WATERPLANE_ALLOW_PUBLIC`) desktop —
   *  absent for one this phone holds none for. Carried only under `bearerForSaved`'s rule: to that
   *  desktop's saved base origin, never its LAN address, never another desktop's. Optional on the
   *  wire both ways: an older shell ignores it, an older bundle never sends it. */
  token?: string;
}

/** What this phone holds for one saved desktop: its device token (the active one's live key,
 *  another's parked copy) and whether that token is a passive (kids') one. */
export interface ShellLinkCreds { token: string | null; passive?: boolean }

/** More desktops than this on one phone is not a case; a bound keeps a bad list from opening sockets. */
export const MAX_SHELL_LINKS = 8;

/**
 * The token one link carries, or null. `bearerForSaved` decides — to the desktop's own saved
 * base origin only (the url the service dials is built from that same base, `wsUrlFor`) — and a
 * PASSIVE token is never carried: the host refuses the socket and `/api/attention` to one
 * (`host/passive.ts`), so sending it would only be a refusal on repeat.
 */
export function shellLinkToken(h: SavedHost, creds: ShellLinkCreds | null | undefined): string | null {
  if (!creds?.token || creds.passive) return null;
  let probe: string;
  try { probe = `${new URL(h.base).origin}/api/attention`; } catch { return null; }
  return bearerForSaved(h, creds.token, probe) ? creds.token : null;
}

export function shellLinkSet(
  hosts: readonly SavedHost[], activeId: string | null, credsFor?: (h: SavedHost) => ShellLinkCreds | null,
  { carry = true, enforcing = false }: { carry?: boolean; enforcing?: boolean } = {},
): ShellLinkSpec[] {
  const ordered = [...hosts].sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId));
  const out: ShellLinkSpec[] = [];
  const seen = new Set<string>();
  for (const h of ordered) {
    if (!isHostId(h.id)) continue;
    const url = wsUrlFor(dialBaseOf(h, enforcing), "/ws");
    // Two rows on one address are one desktop: one socket, or every alert arrives twice.
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const spec: ShellLinkSpec = { hostId: h.id, url, label: h.name || h.base.replace(/^https?:\/\//, "") };
    // `carry: false` is sealed mode on a shell that would store what it is handed: the link still
    // watches the desktop, tokenless, and the service's own `replaceAll` empties its copies.
    const token = carry && credsFor ? shellLinkToken(h, credsFor(h)) : null;
    if (token) spec.token = token;
    out.push(spec);
    if (out.length >= MAX_SHELL_LINKS) break;
  }
  return out;
}

/** What one link said, as the settings row words it. The states are the service's; each is
 *  worded apart and none folds into another. */
export function linkStateWord(state: string): string {
  switch (state) {
    case "connected": return "connected";
    case "connecting": case "starting": return "connecting";
    case "reconnecting": return "not answering — retrying";
    case "auth": return "needs this phone signed in there";
    // It carried this phone's token and the desktop refused it: revoked, or the password changed.
    case "signedOut": return "signed out there — pair again";
    // Sealed mode: the link's token lived in memory and the process died. The next unlock hands it back.
    case "locked": return "locked — open the app";
    // A pin refused what answered there. The service stops, and only a tap can say which key is right.
    case "keyChanged": return "its key does not match this phone — pair again by code";
    // `ShellRoute.WORD_LOCKED`: it holds a pin and this address is not protected, so the service will
    // not dial it. Worded apart from "locked": no token handed back opens this one.
    case "locked: open the app": return "waiting for the app — this address is not protected";
    case "stopped": return "stopped";
    case "unconfigured": return "no address";
    default: return state;
  }
}

/** What the service's last error says, or null when it says nothing a person can use. The adopt
 *  refusal also lands on a vouched address, which is protected to the page but a route the shell
 *  cannot judge, so the sentence shown states only what happened. */
export function linkErrorWord(error: string | null | undefined): string | null {
  if (!error) return null;
  return error.startsWith("a new file was not fetched in the background") ? "a new file was left for the app to fetch when you open it" : error;
}

/** "zenbook connected · studio not answering — retrying". Null for one link or none: the switch's
 *  own state already says it. */
export function linksStateText(links: readonly { label: string; state: string }[] | undefined): string | null {
  if (!links || links.length < 2) return null;
  return links.map((l) => `${l.label} ${linkStateWord(l.state)}`).join(" · ");
}
