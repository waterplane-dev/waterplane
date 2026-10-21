/**
 * The `hosts` overlay: every desktop this phone knows, one tap to switch.
 *
 * Rows: name, address, the active one marked — and the route it is on when
 * the LAN runtime has said (`store.route`). Verbs: add, edit (name, addresses,
 * the LAN side), remove (`Confirm.tsx`, stating what stays saved). A row that
 * cannot do a verb does not draw it; nothing here is ever greyed.
 */
import { useState } from "react";
import { Check, FlaskConical, Globe, KeyRound, Link2, LogOut, Pencil, Plus, QrCode, Router, Server, Trash2 } from "lucide-react";
import { Sheet } from "../../Sheet";
import { Empty } from "../../Empty";
import { HostSetup } from "../../HostSetup";
import { isDemoHost } from "../../hosts";
import { leaveDemo, tryDemo } from "../../demoEntry";
import { useBackStep, useCore } from "../../sdk";
import { confirmRemoveHost, openPairQr, showAddHost, showEditHost, showHostList, switchHost } from "./actions";
import { hostAddress, hostRows } from "./logic";
import { useHostRoute, useHosts, useSwitcherView } from "./store";
import { usePeersSheet } from "../../peersSlot";
import { Button, Row, RowTitle, RowSub, Hint } from "../../kit";

const ICON = 16;

export function HostSwitcherSheet() {
  const c = useCore();
  const { hosts, activeId } = useHosts();
  const v = useSwitcherView();
  const route = useHostRoute();
  const close = () => c.nav.close("hosts");
  // Back — the gesture as much as the arrow — returns to the list, not out.
  const [peers, setPeers] = useState(false);
  const PeersSheet = usePeersSheet();
  useBackStep(peers, () => setPeers(false));
  useBackStep(v.mode !== "list", showHostList);

  // Peer desktops: drawn here, not as an overlay of its own, so Back returns to this list.
  if (peers && PeersSheet) return <PeersSheet onClose={() => setPeers(false)} />;

  if (v.mode === "pair") {
    // A pairing deep-link `…://pair` link filled this in; nothing is sent until "pair".
    return (
      <Sheet title="Pair with a desktop" icon={<KeyRound size={ICON} />} onClose={showHostList}>
        <HostSetup mode="add" pair={v.target} pairFromLink onDone={showHostList} onCancel={showHostList} />
      </Sheet>
    );
  }

  if (v.mode === "add" || v.mode === "edit") {
    const host = v.mode === "edit" ? hosts.find((h) => h.id === v.id) : undefined;
    const isActive = !!host && host.id === activeId;
    return (
      <Sheet title={host ? `Edit ${host.name}` : "Add a desktop"} icon={<Server size={ICON} />} onClose={showHostList}>
        <HostSetup
          mode={host ? "edit" : "add"}
          host={host}
          // The desktop said where it is on the LAN; only the ACTIVE one can have.
          lanSuggest={isActive || !host ? c.conn.info.lanIps : []}
          onDone={showHostList}
          onCancel={showHostList}
        />
      </Sheet>
    );
  }

  return (
    <Sheet
      title="Hosts"
      icon={<Server size={ICON} />}
      onClose={close}
      actions={<Button onClick={showAddHost}><Plus size={ICON} /> add</Button>}
    >
      {hosts.length === 0 ? (
        <Empty thing="saved desktops">No desktops saved on this phone. Add one with its Tailscale address.</Empty>
      ) : (
        <div className="list">
          {hostRows(hosts, activeId).map((h) => {
            const active = h.id === activeId;
            if (isDemoHost(h)) {
              // The demo is a row (`hosts.ts`) so that the real desktop's words are
              // parked while it runs; it has no address to edit, no QR and no
              // "remove" — only the way out.
              return (
                <Row key={h.id} kind="wrap">
                  <Row kind="grow">
                    <RowTitle><FlaskConical size={12} /> {h.name} · in use</RowTitle>
                    <RowSub className="dim">A pretend desktop — nothing runs on a computer</RowSub>
                  </Row>
                  <div className="row-acts">
                    <Button aria-label="leave the demo" onClick={leaveDemo}><LogOut size={ICON} /> leave</Button>
                  </div>
                </Row>
              );
            }
            return (
              <Row key={h.id} kind="wrap">
                {active ? (
                  <Row kind="grow">
                    <RowTitle><Check size={12} /> {h.name} · in use</RowTitle>
                    <RowSub className="dim">{hostAddress(h.base)}{h.lan ? ` · LAN ${hostAddress(h.lan.base)}` : ""}</RowSub>
                    {route && (
                      <RowSub>
                        {route.route === "lan" ? <Router size={12} /> : <Globe size={12} />} {route.sentence}
                      </RowSub>
                    )}
                  </Row>
                ) : (
                  <Row as="button" kind="grow" onClick={() => switchHost(h.id)}>
                    <RowTitle>{h.name}</RowTitle>
                    <RowSub className="dim">{hostAddress(h.base)} · tap to switch</RowSub>
                  </Row>
                )}
                <div className="row-acts">
                  {/* The QR is minted by the host this page talks to — the
                      active one — so only its row offers it. */}
                  {active && (
                    <Button aria-label={`show a pairing QR for ${h.name}`} onClick={openPairQr}><QrCode size={ICON} /></Button>
                  )}
                  <Button aria-label={`edit ${h.name}`} onClick={() => showEditHost(h.id)}><Pencil size={ICON} /></Button>
                  <Button aria-label={`remove ${h.name}`} onClick={() => void confirmRemoveHost(h)}><Trash2 size={ICON} /></Button>
                </div>
              </Row>
            );
          })}
        </div>
      )}
      {PeersSheet && <div className="set-row" style={{ marginTop: 10 }}>
        <Button onClick={() => setPeers(true)}><Link2 size={ICON} /> Peer desktops</Button>
      </div>}
      {!hosts.some(isDemoHost) && (
        <div className="set-row" style={{ marginTop: 10 }}>
          <Button onClick={() => tryDemo()}><FlaskConical size={ICON} /> Try the demo</Button>
        </div>
      )}
      <Hint>
        Each desktop keeps its own drafts, queue and caches on this phone; switching reloads the app onto the other one.
      </Hint>
    </Sheet>
  );
}
