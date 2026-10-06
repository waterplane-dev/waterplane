/**
 * Peer desktops: pair two saved desktops, and the launcher tag that says a
 * session is waiting on one — see README.md.
 */
import type { FeatureManifest } from "../../sdk";
import { setPeerJobsSection, setPeersSheet } from "../../peersSlot";
import { PeerJobsSection } from "./PeerJobsSection";
import { PeersSheet } from "./PeersSheet";

export { PeerWaitTag } from "./PeerWaitTag";
export { PeerRowTags, PeerSessionFacts } from "./PeerFacts";

/**
 * No sheet id of its own (`routing.ts` has no `peers` overlay): the sheet is
 * drawn inside the Hosts sheet, which finds it in `peersSlot.ts` — features
 * never import each other.
 */
export const manifest: FeatureManifest = {
  id: "peers",
  boot: () => {
    setPeersSheet(PeersSheet);
    setPeerJobsSection(PeerJobsSection);
    return () => { setPeersSheet(null); setPeerJobsSection(null); };
  },
};
