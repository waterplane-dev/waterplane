import { useEffect, useState } from "react";
import { BRAND, type SavedHost, type TailnetPeersResponse } from "@waterplane/shared";
import { Check, Loader2, Radar, Server } from "lucide-react";
import { api, bgFetch } from "./api";
import { addAndActivate, listHosts } from "./hosts";
import { emptyFoundText, foundRows, foundSub, healthVerdict, type FoundRow } from "./hostDiscover";
import { Row, RowTitle, RowSub } from "./kit/Row";
import { SetNote } from "./SettingsKit";

/**
 * "Found on your tailnet" in Add a desktop: the connected desktop lists the
 * other waterplane daemons it can see (`GET /api/tailnet/peers`), and a tap on
 * one is the normal add — this phone probes that address's `/api/health ITSELF`
 * first (the connected desktop reaching it proves nothing about this phone),
 * then saves it and switches to it (`addAndActivate`; the words parked under
 * the desktop in use stay). A desktop with a password cannot be added with a tap;
 * it hands over to the pair form, prefilled with its address, and says how to
 * get a code. The typed address below stays the fallback.
 */
type Load = { s: "busy" } | { s: "bad"; why: string } | { s: "ok"; res: TailnetPeersResponse };

export function FoundDesktops({ onPassword }: {
  /** A found desktop that needs a pairing code: open the pair form on its address. */
  onPassword: (base: string, name: string) => void;
}) {
  const [load, setLoad] = useState<Load>({ s: "busy" });
  const [saved, setSaved] = useState<SavedHost[]>(() => listHosts());
  const [picked, setPicked] = useState<string | null>(null);
  const [say, setSay] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setSaved(listHosts());
    api.tailnet.peers()
      .then((res) => { if (live) setLoad({ s: "ok", res }); })
      .catch(() => { if (live) setLoad({ s: "bad", why: "The desktop in use did not answer (an older version cannot list the tailnet). Type the new desktop's address below." }); });
    return () => { live = false; };
  }, []);

  async function pick(row: FoundRow): Promise<void> {
    if (picked) return;
    setPicked(row.base);
    setSay(null);
    try {
      let status = 0;
      let body: unknown = null;
      try {
        const r = await bgFetch(`${row.base}/api/health`, { cache: "no-store", credentials: "omit" }, 6000);
        status = r.status;
        try { body = await r.json(); } catch { /* not JSON */ }
      } catch {
        setSay(`This phone could not reach ${row.peer.addr}, though the desktop in use can. Check that Tailscale is connected on this phone, then try again.`);
        return;
      }
      const verdict = healthVerdict(status, body);
      if (verdict === "password") { onPassword(row.base, row.peer.name); return; }
      if (verdict === "other") { setSay(`${row.peer.addr} answered, but not as a ${BRAND.name} daemon (status ${status}).`); return; }
      const r = addAndActivate({ name: row.peer.name, base: row.base });
      if (!r.ok) setSay(r.why);
    } finally {
      setPicked(null);
    }
  }

  if (load.s === "busy") {
    return <SetNote style={{ marginBottom: 12 }}><Loader2 size={13} className="spin" style={{ verticalAlign: "-2px" }} /> looking on your tailnet…</SetNote>;
  }
  if (load.s === "bad") return <SetNote style={{ marginBottom: 12 }}>{load.why}</SetNote>;

  const rows = foundRows(load.res.peers, saved);
  const fresh = rows.filter((r) => !r.saved);
  return (
    <div style={{ marginBottom: 14 }}>
      <SetNote><Radar size={13} style={{ verticalAlign: "-2px" }} /> found on your tailnet</SetNote>
      {fresh.length === 0 && <SetNote style={{ marginTop: 6 }}>{emptyFoundText(load.res.note, rows.length > 0)}</SetNote>}
      <div className="list" style={{ marginTop: 6 }}>
        {rows.map((r) => r.saved ? (
          <Row key={r.base}>
            <RowTitle><Check size={12} /> {r.peer.name} · already on this phone</RowTitle>
            <RowSub className="dim">{foundSub(r)}</RowSub>
          </Row>
        ) : (
          <Row key={r.base} as="button" onClick={() => void pick(r)}>
            <RowTitle>
              {picked === r.base ? <Loader2 size={12} className="spin" /> : <Server size={12} />} {r.peer.name}
            </RowTitle>
            <RowSub className="dim">{foundSub(r)} · {picked === r.base ? "checking…" : r.peer.gated ? "tap to pair" : "tap to add"}</RowSub>
          </Row>
        ))}
      </div>
      {say && <SetNote style={{ marginTop: 8, color: "var(--dead)" }}>{say}</SetNote>}
    </div>
  );
}
