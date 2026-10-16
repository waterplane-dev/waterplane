/**
 * The host switcher's pure half: what a host's unsent words ADD UP to (the
 * count the remove question states), and how a host is worded on a row.
 * Node-tested (`logic.test.mjs`); reads nothing — `actions.ts` hands it a
 * getter over either the bare keys (the active host) or its parked ones.
 */
import { agoText } from "../../format.ts";
import { parsePad, type DeviceRow, type PeerKind, type SavedHost } from "@waterplane/shared";

/** What a host's saved-but-unsent words are, by kind. */
export interface HostWords { drafts: number; notes: number; queued: number }

/** The storage keys that hold words, by their bare names (`storage.ts`'s `LS`). */
export interface WordKeys {
  composeDrafts: string;
  composeSheets: string;
  compose: string;
  backlogDraft: string;
  fanoutText: string;
  pad: string;
  composeOutbox: string;
  outbox: string;
}

function json(raw: string | null): unknown {
  if (raw == null || raw === "") return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

/** A stored text draft: a JSON string or a raw one. Blank counts as nothing. */
function textDraft(raw: string | null): number {
  const v = json(raw);
  return typeof v === "string" && v.trim() ? 1 : 0;
}

/** A `{key: text}` map of drafts: the non-blank ones. */
function mapDrafts(raw: string | null): number {
  const v = json(raw);
  if (!v || typeof v !== "object" || Array.isArray(v)) return 0;
  return Object.values(v as Record<string, unknown>).filter((t) => typeof t === "string" && t.trim()).length;
}

function listLen(raw: string | null): number {
  const v = json(raw);
  return Array.isArray(v) ? v.length : 0;
}

/**
 * Count one host's words. Every queue row counts, `failed` included — a failed
 * row is kept in full for ever, so it is exactly a word that would be missed.
 */
export function countHostWords(get: (bareKey: string) => string | null, k: WordKeys): HostWords {
  return {
    drafts: mapDrafts(get(k.composeDrafts)) + mapDrafts(get(k.composeSheets))
      + textDraft(get(k.compose)) + textDraft(get(k.backlogDraft)) + textDraft(get(k.fanoutText)),
    notes: parsePad(get(k.pad)).notes.length,
    queued: listLen(get(k.composeOutbox)) + listLen(get(k.outbox)),
  };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "3 drafts, 2 pad notes and 1 queued prompt" — or null when there is nothing. */
export function wordsText(w: HostWords): string | null {
  const parts = [
    w.drafts ? plural(w.drafts, "draft", "drafts") : null,
    w.notes ? plural(w.notes, "pad note", "pad notes") : null,
    w.queued ? plural(w.queued, "queued prompt", "queued prompts") : null,
  ].filter((p): p is string => !!p);
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The remove question's lines: what stays, and — for the active host — where
 *  the app goes instead. Nothing here is ever deleted, and the lines say so. */
export function removeLines(w: HostWords, active: boolean, next: SavedHost | null): string[] {
  const what = wordsText(w);
  const n = w.drafts + w.notes + w.queued;
  const lines = [what
    ? `${what} ${n === 1 ? "stays" : "stay"} saved on this phone; re-add the host to see them.`
    : "Nothing unsent is saved for it on this phone."];
  if (active) {
    lines.push(next
      ? `It is the host in use: the app switches to ${next.name} first, then reloads.`
      : "It is the only host: the app goes back to the connect screen.");
  }
  return lines;
}

/** An address as a row shows it: no scheme, no default port. */
export function hostAddress(base: string): string {
  return base.replace(/^https?:\/\//, "").replace(/:8770$/, "");
}

/** The session header names the host only when there is more than one — a
 *  single desktop is not a fact worth a line. */
export function showHostName(hosts: readonly SavedHost[]): boolean {
  return hosts.length > 1;
}

/** The launcher bar's switch key names the desktop in a few letters — its
 *  first word ("DeskMini-von-Alex" → "DeskM…"), capped so the key fits
 *  beside the settings cog instead of wrapping onto a row of its own. The
 *  full name is the title and the menu row. */
export const SHORT_HOST_MAX = 6;
export function shortHostName(name: string): string {
  const first = name.trim().split(/[\s\-_.·]+/).find((w) => w.length > 0) ?? "";
  return first.length > SHORT_HOST_MAX ? `${first.slice(0, SHORT_HOST_MAX - 1)}…` : first;
}

/** The toggle half of that key: the next of the person's own desktops after
 *  the one in use, wrapping — so two hosts flip and three go round. `hosts`
 *  arrives without the demo row (`realHosts`). Fewer than two, or nothing but
 *  the one in use ⇒ null, and the key is not drawn. */
export function nextHostId(hosts: readonly SavedHost[], activeId: string | null): string | null {
  if (hosts.length < 2) return null;
  const i = hosts.findIndex((h) => h.id === activeId);
  return hosts[(i + 1) % hosts.length].id;
}

/** Active first, then the order they were added — so the row a thumb wants
 *  (another one) is never under the one it is on. */
export function hostRows(hosts: readonly SavedHost[], activeId: string | null): SavedHost[] {
  const a = hosts.filter((h) => h.id === activeId);
  return [...a, ...hosts.filter((h) => h.id !== activeId)];
}

// ── Pair another phone: the QR ──────────────────────────────────────────

/**
 * An SVG path drawing every dark module of an `n`×`n` QR, one unit per
 * module, runs along a row merged into one rectangle (a 57-module code is a
 * few hundred subpaths, not three thousand). The caller adds the quiet zone
 * through the viewBox.
 */
export function qrPath(n: number, isDark: (row: number, col: number) => boolean): string {
  const out: string[] = [];
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!isDark(r, c)) { c++; continue; }
      let e = c;
      while (e < n && isDark(r, e)) e++;
      out.push(`M${c} ${r}h${e - c}v1h${c - e}z`);
      c = e;
    }
  }
  return out.join("");
}

/** `9:41 left`, or null once it is spent. Whole seconds, rounded UP — a
 *  code must not read `0:00 left` while it still works. */
export function codeLeftText(msLeft: number): string | null {
  if (!(msLeft > 0)) return null;
  const s = Math.ceil(msLeft / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left`;
}

// ── Paired devices ──────────────────────────────────────────────────────

/** How the device last came in, as a clause. */
export function deviceRouteText(kind: PeerKind | null): string {
  switch (kind) {
    case "tailscale": return "over the tailnet";
    case "lan": return "over the Wi-Fi (LAN)";
    case "loopback": return "on the desktop itself";
    case "public": return "over a public address";
    default: return "route not recorded";
  }
}

/** `just now` · `4 min ago` · `3 h ago` · `2 d ago` — `agoText`, under the name this screen uses. */
export const seenAgo = agoText;

/** The revoke question's lines. Revoking THIS phone is allowed, and says what it does. */
export function revokeLines(row: Pick<DeviceRow, "name" | "current">): string[] {
  return row.current
    ? [
        "This is the phone you are holding. Revoking it signs this phone out of this desktop at once.",
        "It will need a new pairing code (or the password) to connect again.",
      ]
    : [`${row.name} will need a new pairing code to connect again.`];
}

/** What the list says when it has no rows — or why there can be none. */
export function devicesEmptyText(passwordSet: boolean): string {
  return passwordSet
    ? "No phone has its own sign-in yet. Pair one with \"pair another phone\" — each gets a row here you can revoke."
    : "Set a host password to give each phone its own sign-in. Without one, this desktop keeps no per-phone sign-ins to list or revoke.";
}
