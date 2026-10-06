/**
 * "Add a desktop", the pure half: which desktops the connected one found on
 * the tailnet (`GET /api/tailnet/peers`, `host/tailnetpeers.ts`), which of them
 * this phone already holds, and what a tap on a row is told by the desktop's own
 * `/api/health`. Node-tested (`hostDiscover.test.mjs`); `FoundDesktops.tsx` is
 * the screen.
 */
import { BRAND, normalizeHostBase, type SavedHost, type TailnetPeer } from "@waterplane/shared";

export interface FoundRow {
  peer: TailnetPeer;
  /** The `http://100.x:port` this phone would save. */
  base: string;
  /** The saved desktop at that address, or null. */
  saved: SavedHost | null;
}

/** Peers as rows, those already on this phone marked (and last). Order otherwise kept. */
export function foundRows(peers: readonly TailnetPeer[], saved: readonly SavedHost[]): FoundRow[] {
  const rows: FoundRow[] = [];
  for (const peer of peers) {
    const base = normalizeHostBase(peer.addr);
    if (!base) continue;
    rows.push({ peer, base, saved: saved.find((h) => normalizeHostBase(h.base) === base) ?? null });
  }
  return [...rows.filter((r) => !r.saved), ...rows.filter((r) => r.saved)];
}

/** What `GET <base>/api/health` said when this phone asked it directly. */
export type HealthVerdict = "open" | "password" | "other";

export function healthVerdict(status: number, body: unknown): HealthVerdict {
  const b = body as { ok?: unknown; authRequired?: unknown } | null;
  if (status === 200 && b && b.ok === true) return "open";
  if (status === 401 && b && b.authRequired === true) return "password";
  return "other";
}

/** The sentence under a found desktop that has a password: what to do, in order. */
export function passwordSentence(name: string): string {
  return `${name} has a password, so it needs a pairing code. On that desktop run "${BRAND.slug} pair" and paste the link it prints below — or, on a phone already paired to it, open Hosts and tap its QR icon.`;
}

/** Why the list is empty, as a sentence; the host's own `note` wins. */
export function emptyFoundText(note: string | undefined, allSaved: boolean): string {
  if (note) return note;
  return allSaved ? "Every desktop found on the tailnet is already on this phone." : `No other ${BRAND.name} desktop answered on the tailnet.`;
}

/** The row's one-line description. */
export function foundSub(row: FoundRow): string {
  const os = row.peer.os ? `${row.peer.os} · ` : "";
  return `${os}${row.peer.addr}${row.peer.gated ? " · has a password" : ""}`;
}
