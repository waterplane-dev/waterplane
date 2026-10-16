/**
 * The launcher bar's host switch — drawn only when this phone knows two or
 * more of its own desktops. A SPLIT key sized to sit beside the settings cog
 * (it wrapped onto a row of its own when it spelled out a word and an icon):
 *
 * - the wide half TOGGLES — straight to the next desktop (`nextHostId`: two
 *   flip, three go round), the same park + reload as a tap in the switcher.
 *   It shows the swap glyph over the short name of the one IN USE, so after
 *   the reload the key itself says where you landed.
 * - the narrow chevron opens the switcher, where every host is named in full.
 */
import { ArrowLeftRight, ChevronDown } from "lucide-react";
import { realHosts } from "../../hosts";
import { openHosts, switchHost } from "./actions";
import { nextHostId, shortHostName } from "./logic";
import { useHosts } from "./store";

export function HostSwitchKey() {
  const { hosts, activeId } = useHosts();
  const own = realHosts(hosts);
  const next = nextHostId(own, activeId);
  if (!next) return null;
  const name = hosts.find((h) => h.id === activeId)?.name ?? "no host";
  const nextName = own.find((h) => h.id === next)?.name ?? next;
  return (
    <div className="host-key" role="group" aria-label="desktop">
      <button className="host-key-flip" title={`on ${name} — tap to switch to ${nextName}`}
        aria-label={`on ${name}, switch to ${nextName}`} onClick={() => switchHost(next)}>
        <ArrowLeftRight size={14} aria-hidden="true" />
        <span className="host-key-name">{shortHostName(name)}</span>
      </button>
      <button className="host-key-menu" title={`all desktops (${own.length})`}
        aria-label="all desktops" onClick={openHosts}>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
    </div>
  );
}
