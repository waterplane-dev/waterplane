/**
 * The host's name on the session header — drawn only when this phone knows
 * more than one desktop (`showHostName`); with one, it is not a fact.
 */
import { Server } from "lucide-react";
import { showHostName } from "./logic";
import { useHosts } from "./store";

export function HostNameTag() {
  const { hosts, activeId } = useHosts();
  if (!showHostName(hosts)) return null;
  const name = hosts.find((h) => h.id === activeId)?.name;
  if (!name) return null;
  return <span className="row-sub"> · <Server size={11} aria-hidden="true" /> {name}</span>;
}
