/**
 * Peer pairing's verbs. The phone is the only party that knows both desktops,
 * so it writes both ledgers; neither desktop ever hears of the other from the
 * phone's word alone — each is handed the other's address and a token, over
 * the tailnet, by a device it already trusts.
 *
 * Tokens: one fresh random token per direction, minted here, sent once to each
 * side (as that side's outbound or inbound token) and never stored on the
 * phone. A re-pair mints new ones, which replaces the old on both hosts.
 */
import { parkedKeyFor, type PeerStatusResponse, type SavedHost } from "@waterplane/shared";
import { api } from "../../api";
import { askConfirm } from "../../Confirm";
import { deviceToken, isDeviceToken } from "../../deviceToken";
import { activeHost, browserKV, listHosts, readHosts, realHosts, switchTo, writeSwitch } from "../../hosts";
import { isNativeShell } from "../../hostUrl";
import { LS, lsGet } from "../../storage";
import { core } from "../../sdk";
import {
  mintPeerToken, noHostText, pairBodies, pairCandidates, pairRefusal, peerNameFor, peerReplyWhy, peerTagFacts, selfAddrs, sidesText,
  type HostLedger, type PairedRow, type PeerRowView, type PeerTagFacts, type SideResult,
} from "./logic";
import { peersState } from "./store";

/** The hosts a pairing can involve: the person's own, native shell only. */
export function pairableHosts(): SavedHost[] {
  return isNativeShell() ? realHosts(listHosts()) : [];
}

/** This phone's token for `host`: bare for the active one, parked for the rest. */
function tokenFor(host: SavedHost): string | null {
  const active = activeHost();
  const t = active?.id === host.id ? deviceToken() : lsGet(parkedKeyFor(LS.deviceToken, host.id));
  return isDeviceToken(t) ? t : null;
}

function busy(delta: 1 | -1): void {
  peersState.set((s) => ({ ...s, busy: Math.max(0, s.busy + delta) }));
}
const say = (note: string | null): void => peersState.set((s) => ({ ...s, note }));

function asRows(body: unknown): PeerRowView[] | null {
  const peers = body && typeof body === "object" ? (body as { peers?: unknown }).peers : null;
  if (!Array.isArray(peers)) return null;
  return peers.flatMap((p): PeerRowView[] => {
    const r = p as Partial<PeerRowView>;
    return typeof r?.name === "string" && typeof r.addr === "string"
      ? [{ name: r.name, addr: r.addr, outbound: r.outbound === true, inbound: r.inbound === true, addedAt: typeof r.addedAt === "number" ? r.addedAt : 0 }]
      : [];
  });
}

/** What the host calls itself on the tailnet (`self.addr`), or null. */
function asSelf(body: unknown): string | null {
  const s = body && typeof body === "object" ? (body as { self?: { addr?: unknown } }).self : null;
  return typeof s?.addr === "string" && s.addr ? s.addr : null;
}

/** Read every saved host's ledger. A host that does not answer is listed as such, never dropped. */
export async function loadPeers(): Promise<void> {
  const cands = pairCandidates(pairableHosts());
  busy(1);
  try {
    const ledgers = await Promise.all(cands.map(async (c): Promise<HostLedger> => {
      try {
        const r = await api.peers.on(c.host.base, tokenFor(c.host), "GET", "/api/peers");
        const rows = r.status === 200 ? asRows(r.body) : null;
        const self = r.status === 200 ? asSelf(r.body) : null;
        return rows
          ? { host: c.host, addr: pairCandidates([c.host], { [c.host.id]: self })[0]!.addr, rows, self }
          : { host: c.host, addr: c.addr, rows: null, error: peerReplyWhy(r.status, r.body) };
      } catch {
        return { host: c.host, addr: c.addr, rows: null, error: "did not answer" };
      }
    }));
    peersState.set((s) => ({ ...s, ledgers, loaded: true }));
    void loadSignIns(ledgers);
  } finally { busy(-1); }
}

/** Ask each host about every peer it can call: is claude signed in there. Silent on any failure. */
async function loadSignIns(ledgers: HostLedger[]): Promise<void> {
  const asks = ledgers.flatMap((l) => (l.rows ?? []).filter((r) => r.outbound).map((r) => ({ l, r })));
  const got = await Promise.all(asks.map(async ({ l, r }) => {
    try {
      const res = await api.peers.on(l.host.base, tokenFor(l.host), "GET", `/api/peers/${encodeURIComponent(r.name)}/status`);
      const b = res.body as PeerStatusResponse | null;
      return res.status === 200 && b?.ok && typeof b.claudeSignedIn === "boolean" ? [[`${l.host.id}/${r.name}`, b.claudeSignedIn] as const] : [];
    } catch { return []; }
  }));
  peersState.set((s) => ({ ...s, signedIn: Object.fromEntries(got.flat()) }));
}

export function pick(which: "a" | "b", id: string | null): void {
  peersState.set((s) => ({ ...s, pick: { ...s.pick, [which]: id } }));
}

/** Pair two saved hosts both ways. Refusals are sentences from `pairRefusal`; nothing is written then. */
export async function pairHosts(aId: string, bId: string): Promise<void> {
  const cands = pairCandidates(pairableHosts(), selfAddrs(peersState.get().ledgers));
  const a = cands.find((c) => c.host.id === aId);
  const b = cands.find((c) => c.host.id === bId);
  const why = pairRefusal(a, b);
  if (why || !a || !b || !a.addr || !b.addr) { say(why ?? "choose two desktops"); return; }
  core().say.track("action:peers.pair");
  const ledgers = peersState.get().ledgers;
  const rowsOf = (id: string) => ledgers.find((l) => l.host.id === id)?.rows ?? [];
  // A name already pointing at the same address is reused (a re-pair replaces
  // the row); a name taken by a DIFFERENT address is never overwritten.
  const nameOn = (id: string, other: { name: string }, addr: string): string => {
    const rows = rowsOf(id);
    return rows.find((r) => r.addr === addr)?.name ?? peerNameFor(other.name, rows.map((r) => r.name));
  };
  const nameOfB = nameOn(a.host.id, b.host, b.addr);
  const nameOfA = nameOn(b.host.id, a.host, a.addr);
  const { forA, forB } = pairBodies({ addr: a.addr }, { addr: b.addr }, nameOfB, nameOfA, mintPeerToken(), mintPeerToken());
  busy(1);
  say(`pairing ${a.host.name} and ${b.host.name}…`);
  try {
    const write = async (host: SavedHost, body: unknown): Promise<SideResult> => {
      try {
        const r = await api.peers.on(host.base, tokenFor(host), "POST", "/api/peers", body);
        return r.status === 200 ? { host: host.name, ok: true } : { host: host.name, ok: false, why: peerReplyWhy(r.status, r.body) };
      } catch { return { host: host.name, ok: false }; }
    };
    const sides = await Promise.all([write(a.host, forA), write(b.host, forB)]);
    say(sidesText("paired", sides));
  } finally { busy(-1); }
  await loadPeers();
}

/** Remove a pairing from BOTH hosts, once asked; says which side failed. */
export async function unpair(p: PairedRow): Promise<void> {
  const both = p.other && p.mirror;
  const ok = await askConfirm({
    title: p.other ? `Unpair ${p.host.name} and ${p.other.name}?` : `Remove ${p.row.name} from ${p.host.name}?`,
    lines: [
      both ? "Each desktop forgets the other and its token stops working at once." : "Only the side listed is removed.",
      "Jobs already running on a peer are not cancelled; their reports will not come back.",
    ],
    confirmLabel: "Unpair",
  });
  if (!ok) return;
  core().say.track("action:peers.unpair");
  const del = async (host: SavedHost, name: string): Promise<SideResult> => {
    try {
      const r = await api.peers.on(host.base, tokenFor(host), "DELETE", `/api/peers/${encodeURIComponent(name)}`);
      // 404: already gone, which is what was asked for.
      return r.status === 200 || r.status === 404 ? { host: host.name, ok: true } : { host: host.name, ok: false, why: peerReplyWhy(r.status, r.body) };
    } catch { return { host: host.name, ok: false }; }
  };
  busy(1);
  try {
    const jobs = [del(p.host, p.row.name)];
    if (p.other && p.mirror) jobs.push(del(p.other, p.mirror.name));
    say(sidesText("unpaired", await Promise.all(jobs)));
  } finally { busy(-1); }
  await loadPeers();
}

/**
 * The tag's tap: switch to the saved host the peer's address names and land on
 * the peer's session. No saved host ⇒ a sentence, nothing else. The switch is
 * `hosts.ts`'s two-phase one (park now, restore at the next boot), with the
 * route carried in the hash the reload keeps.
 */
export function openPeerSession(f: PeerTagFacts, peer: string): void {
  core().say.track("action:peers.open");
  if (!f.target) { core().say.toast(noHostText(peer)); return; }
  if (activeHost()?.id === f.target.id) { core().say.toast(`${f.target.name} is the desktop in use`); return; }
  const kv = browserKV();
  if (!kv || !f.sessionId) { if (!switchTo(f.target.id)) core().say.toast("already on that host"); return; }
  if (!readHosts(kv).some((h) => h.id === f.target!.id)) { core().say.toast(noHostText(peer)); return; }
  const from = kv.getItem(LS.hostActive);
  writeSwitch(kv, { from: from && from !== f.target.id ? from : null, to: f.target.id });
  try { history.replaceState(null, "", `${location.pathname}#a=${encodeURIComponent(f.sessionId)}`); } catch { /* keep the url */ }
  location.reload();
}

export { peerTagFacts };
