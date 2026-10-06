/**
 * The launcher menu's host row, in the Android shell: the active host's NAME
 * (+ the route once the LAN runtime has said) and a tap into the switcher.
 * It used to sit in the topbar's brand slot, where a long desktop name took
 * the whole row; which desktop this is gets asked rarely, so it lives with
 * the other one-tap-into-a-sheet entries.
 */
import { Globe, Monitor, Router } from "lucide-react";
import { openHosts } from "./actions";
import { useHostRoute, useHosts } from "./store";

export function HostMenuItem({ size, onOpen }: { size: number; onOpen: () => void }) {
  const { hosts, activeId } = useHosts();
  const route = useHostRoute();
  const name = hosts.find((h) => h.id === activeId)?.name ?? "no host";
  return (
    <button className="more-act host-item" title={`host ${name} — switch desktop`}
      onClick={() => { onOpen(); openHosts(); }}>
      <Monitor size={size} /><span className="host-item-name">{name}</span>
      {route && <>{" · "}{route.route === "lan" ? <Router size={12} /> : <Globe size={12} />}{route.route === "lan" ? "LAN" : "tailnet"}</>}
    </button>
  );
}
