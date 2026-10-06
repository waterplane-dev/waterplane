/**
 * Peer pairing's pure half: which saved hosts can be paired, what each host is
 * told, which rows are two halves of one pairing, and the words for a failure.
 * Node-tested (`logic.test.mjs`); reads no storage and opens no socket —
 * `actions.ts` hands it what it needs.
 *
 * Nothing here judges an address itself: `peerAddressOk` (shared) is the one
 * rule the host also applies, so the phone cannot offer a pairing the host
 * would refuse.
 */
import {
  PEER_NAME_RE, cleanPeerJobCost, fmtCount, peerAddressOk, peerCostParts, peerDurationText, peerJobStateWords, peerWaitWords, peerWeekText,
  type PeerJobLedgerRow, type SavedHost, type SessionInfo,
} from "@waterplane/shared";

/** One row of a host's peer ledger, as `GET /api/peers` returns it (no secrets). */
export interface PeerRowView { name: string; addr: string; outbound: boolean; inbound: boolean; addedAt: number }

/** `host:port` of a saved base (any route: tailnet or LAN), or why there is none. Never a guess at a port. */
function hostPort(base: string): { addr: string } | { why: string } {
  let u: URL;
  try { u = new URL(base); } catch { return { why: "its saved address cannot be read" }; }
  if (!u.hostname) return { why: "its saved address cannot be read" };
  // `URL.port` is "" for a default port, which is also what a front door
  // (`tailscale serve`, https) looks like. A peer calls the daemon itself.
  if (!u.port) return { why: "its saved address has no port — peers call the daemon directly, so save it as host:port (for example 100.64.0.2:8770)" };
  const host = u.hostname.startsWith("[") ? u.hostname : u.hostname.includes(":") ? `[${u.hostname}]` : u.hostname;
  return { addr: `${host}:${u.port}` };
}

/** `host:port` of a saved base, only when the shared rule vouches for it — or why not. */
export function hostPeerAddr(base: string): { addr: string } | { why: string } {
  const r = hostPort(base);
  if (!("addr" in r)) return r;
  const addr = r.addr;
  const bad = peerAddressOk(addr);
  return bad ? { why: `${bad} (${addr})` } : { addr };
}

/** The name one host will know the other by: lower-case slug in `PEER_NAME_RE`'s alphabet, never one in `taken`. */
export function peerNameFor(hostName: string, taken: Iterable<string> = []): string {
  const used = new Set([...taken].map((t) => t.toLowerCase()));
  let slug = hostName.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/-+$/, "").slice(0, 28);
  if (!slug || !PEER_NAME_RE.test(slug)) slug = "peer";
  if (!used.has(slug)) return slug;
  for (let i = 2; i < 100; i++) {
    const c = `${slug}-${i}`;
    if (!used.has(c)) return c;
  }
  return `${slug}-${used.size + 1}`;
}

/** One 256-bit token: 43 base64url characters, from the phone's own randomness. */
export function mintPeerToken(rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const b = rand(32);
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Hosts a pairing can pick between: a verdict per saved host, a sentence when it cannot. */
export interface PairCandidate { host: SavedHost; addr: string | null; why: string | null }

/**
 * `self` is what each host said of itself (`GET /api/peers` -> `self.addr`, host id -> tailnet
 * `ip:port`, or null): a host saved as an https front door still has an address a peer can call.
 * It is used only when `peerAddressOk` vouches for it; otherwise the saved base is tried, and a
 * host with neither is refused with the saved base's sentence.
 */
export function pairCandidates(hosts: readonly SavedHost[], self: Readonly<Record<string, string | null | undefined>> = {}): PairCandidate[] {
  return hosts.map((host) => {
    const own = self[host.id];
    if (typeof own === "string" && !peerAddressOk(own)) return { host, addr: own, why: null };
    const r = hostPeerAddr(host.base);
    return "addr" in r ? { host, addr: r.addr, why: null } : { host, addr: null, why: r.why };
  });
}

/** Host id -> the address that host reported for itself, from the ledgers as last read. */
export function selfAddrs(ledgers: readonly HostLedger[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const l of ledgers) out[l.host.id] = l.self ?? null;
  return out;
}

/** Why `a` and `b` cannot be paired, or null. Says WHICH host and why. */
export function pairRefusal(a: PairCandidate | undefined, b: PairCandidate | undefined): string | null {
  if (!a || !b) return "choose two desktops";
  if (a.host.id === b.host.id) return "choose two different desktops";
  if (a.why) return `${a.host.name}: ${a.why}`;
  if (b.why) return `${b.host.name}: ${b.why}`;
  if (a.addr === b.addr) return `${a.host.name} and ${b.host.name} are saved at the same address`;
  return null;
}

export interface PairBody { name: string; addr: string; outboundToken: string; inboundToken: string }

/**
 * What each side is told. `aToB` is the token A presents when it calls B —
 * so it is A's `outboundToken` and B's `inboundToken` — and `bToA` the other
 * way round. Each host is given the OTHER's name and address.
 */
export function pairBodies(
  a: { addr: string }, b: { addr: string }, nameOfB: string, nameOfA: string, aToB: string, bToA: string,
): { forA: PairBody; forB: PairBody } {
  return {
    forA: { name: nameOfB, addr: b.addr, outboundToken: aToB, inboundToken: bToA },
    forB: { name: nameOfA, addr: a.addr, outboundToken: bToA, inboundToken: aToB },
  };
}

/** A host's ledger as read — or why it could not be. */
export interface HostLedger { host: SavedHost; addr: string | null; rows: PeerRowView[] | null; error?: string; /** the host's own tailnet ip:port, when it said one */ self?: string | null }

/** One pairing as the sheet lists it: this host's row and, when it is there, the other side's. */
export interface PairedRow {
  key: string;
  host: SavedHost;
  row: PeerRowView;
  /** The host that row's address names, when it is a saved one. */
  other: SavedHost | null;
  /** The other side's row for THIS host, when that ledger was read and has one. */
  mirror: PeerRowView | null;
  /** `other`'s ledger could not be read, so `mirror` is unknown rather than absent. */
  mirrorUnknown: boolean;
}

/**
 * Every row of every ledger, two halves of one pairing folded into one line
 * (kept on the host that sorts first, so the count and the list agree).
 * A row whose address matches no saved host stays one-sided and says so.
 */
export function pairedRows(ledgers: readonly HostLedger[]): PairedRow[] {
  const byAddr = new Map<string, HostLedger>();
  for (const l of ledgers) if (l.addr) byAddr.set(l.addr, l);
  const out: PairedRow[] = [];
  for (const l of ledgers) {
    for (const row of l.rows ?? []) {
      const o = byAddr.get(row.addr) ?? null;
      const mirror = o?.rows && l.addr ? o.rows.find((r) => r.addr === l.addr) ?? null : null;
      // Fold: when the other half exists and sorts first, it carries the line.
      if (o && mirror && o.host.id < l.host.id) continue;
      out.push({
        key: `${l.host.id}/${row.name}`, host: l.host, row, other: o?.host ?? null, mirror,
        mirrorUnknown: !!o && !o.rows,
      });
    }
  }
  return out;
}

/** The line a pairing is listed as. */
export function pairedTitle(p: PairedRow): string {
  return p.other ? `${p.host.name} ⇄ ${p.other.name}` : `${p.host.name} → ${p.row.name}`;
}

/** What is true of the pairing, in words; empty when both halves are there. */
export function pairedNote(p: PairedRow): string {
  if (!p.other) return `${p.row.addr} is not one of the desktops saved on this phone — only ${p.host.name}'s side is listed`;
  if (p.mirrorUnknown) return `${p.other.name} could not be reached, so its side is not known`;
  if (!p.mirror) return `only ${p.host.name}'s side exists — ${p.other.name} has no row for it`;
  const hostSide = p.row.outbound && p.row.inbound ? "" : p.row.outbound ? `${p.host.name} can call ${p.other.name} but not the reverse` : `${p.other.name} can call ${p.host.name} but not the reverse`;
  return hostSide;
}

/** Said only when the peer answered "not signed in"; a yes or no answer says nothing. */
export function peerSignInNote(p: PairedRow, signedIn: boolean | undefined): string {
  if (signedIn !== false) return "";
  const there = p.other?.name ?? p.row.name;
  return `claude is not signed in on ${there}: a job sent there stops at its sign-in screen. ` +
    (p.other ? `Switch to ${there}, open any session and tap its sign-in button.` : `Sign in on ${there} (open a session there and tap its sign-in button).`);
}

/** One side's outcome of a write. */
export interface SideResult { host: string; ok: boolean; why?: string }

/** Words for a two-sided write: all fine, or exactly which side failed and what that leaves. */
export function sidesText(verb: "paired" | "unpaired", sides: readonly SideResult[]): string {
  const bad = sides.filter((s) => !s.ok);
  if (!bad.length) return `${sides.map((s) => s.host).join(" and ")} ${verb}`;
  const good = sides.filter((s) => s.ok);
  const failed = bad.map((s) => `${s.host}${s.why ? ` (${s.why})` : ""}`).join(" and ");
  const left = verb === "paired"
    ? good.length ? `${good.map((s) => s.host).join(" and ")} was written, so the pairing is one-sided until you pair again` : "nothing was written"
    : good.length ? `${good.map((s) => s.host).join(" and ")} was removed, ${failed.includes(" and ") ? "the others still hold" : "the other still holds"} a row` : "nothing was removed";
  return `${failed} did not answer — ${left}`;
}

/** The peer ledger's own `error` sentence when it sent one, else the status. */
export function peerReplyWhy(status: number, body: unknown): string {
  const e = body && typeof body === "object" ? (body as { error?: unknown }).error : null;
  if (typeof e === "string" && e) return e;
  if (status === 403) return "this phone is not allowed to manage peers there";
  if (status === 401) return "this phone is not signed in there";
  return `status ${status}`;
}

/** The saved host a peer's address base names (tailnet or LAN side), or null. */
export function hostForPeerBase(peerBase: string | undefined, hosts: readonly SavedHost[]): SavedHost | null {
  if (!peerBase) return null;
  const want = hostPort(/^[a-z]+:\/\//i.test(peerBase) ? peerBase : `http://${peerBase}`);
  if (!("addr" in want)) return null;
  const same = (base: string): boolean => { const r = hostPort(base); return "addr" in r && r.addr === want.addr; };
  return hosts.find((h) => same(h.base) || (!!h.lan && same(h.lan.base))) ?? null;
}

export interface PeerTagFacts {
  /** "waiting on pc · 4 min" */
  text: string;
  /** The saved host to switch to; null = none matches (say so). */
  target: SavedHost | null;
  /** The peer's session to open there, when the host said which. */
  sessionId: string | null;
  /** What a tap will do, in a sentence (the tag's title). */
  title: string;
}

/** The row tag, or null when the session waits on nothing (or on nothing sayable). */
export function peerTagFacts(s: Pick<SessionInfo, "peerWait">, hosts: readonly SavedHost[], activeId: string | null, now: number): PeerTagFacts | null {
  const w = s.peerWait;
  const text = peerWaitWords(w, now);
  if (!w || !text) return null;
  const target = hostForPeerBase(w.peerBase, hosts);
  const sessionId = w.peerSessionId ?? null;
  let title: string;
  if (!target) title = `${w.peer} is not one of the desktops saved on this phone — add it to open its session`;
  else if (target.id === activeId) title = `${w.peer} is the desktop in use`;
  else title = `switch to ${target.name}${sessionId ? " and open the job's session" : ""}`;
  return { text, target, sessionId, title };
}

/**
 * One row of the Activity sheet's "peer jobs" section, as words — the asker's
 * ledger row (`GET /api/peerjobs`) read on the phone's clock. Every figure is
 * the peer's own measurement (`PeerJobCost`) and each is ABSENT when it was
 * not measured; the tokens keep their four kinds apart.
 */
export interface PeerJobRowFacts {
  /** "run e2e → pc" */
  title: string;
  /** "done · sent 12 min ago" */
  state: string;
  /** "$0.84 · opus-5-5 · 6 min · ≈0.05% of week", or null when nothing was measured. */
  cost: string | null;
  /** "in 17 · out 1.1k · cache read 52k · cache write 4.5k", or null. */
  tokens: string | null;
  /** What the money leaves out, or null. */
  costNote: string | null;
  /** The asking session's label, as it was when the job was sent. */
  asker: string | null;
  /** The sentence a refused / failed / unreachable job carries. */
  detail: string | null;
  bad: boolean;
}

export function peerJobRowFacts(r: PeerJobLedgerRow, now: number): PeerJobRowFacts {
  const cost = cleanPeerJobCost(r.cost);
  const parts = [...peerCostParts(cost), peerWeekText(cost?.weekPct)].filter(Boolean);
  const t = cost?.tokens;
  const ago = Number.isFinite(r.since) && r.since > 0 && now >= r.since ? peerDurationText(Math.max(now - r.since, 1)) : "";
  const stateWord = peerJobStateWords(r.state) || "state unknown";
  return {
    title: `${typeof r.label === "string" && r.label.trim() ? r.label.trim() : "a job"} → ${r.peer}`,
    state: [stateWord, ago ? `sent ${ago === "<1 min" ? "just now" : `${ago} ago`}` : "", r.closed ? "closed" : ""].filter(Boolean).join(" · "),
    cost: parts.length ? parts.join(" · ") : null,
    tokens: t ? `in ${fmtCount(t.in)} · out ${fmtCount(t.out)} · cache read ${fmtCount(t.cacheRead)} · cache write ${fmtCount(t.cacheWrite)}` : null,
    costNote: cost?.usd != null
      ? `list price on ${r.peer}, subagents included${cost.unpricedTok ? `; ${fmtCount(cost.unpricedTok)} tokens on a model with no published rate are not in it` : ""}`
      : cost?.tokens ? `${r.peer} could not price this job's model` : null,
    asker: typeof r.askerLabel === "string" && r.askerLabel.trim() ? r.askerLabel.trim() : null,
    detail: typeof r.detail === "string" && r.detail.trim() ? r.detail.trim() : null,
    bad: r.state === "failed" || r.state === "refused" || r.state === "unreachable",
  };
}

/** The sentence when a tap finds no saved host. */
export function noHostText(peer: string): string {
  return `${peer} is not saved on this phone — add it under Hosts to open its session`;
}
