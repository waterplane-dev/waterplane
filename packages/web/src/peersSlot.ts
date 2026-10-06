/**
 * Where the Hosts sheet finds the peers sheet. Features never import each
 * other (`local/feature-boundary`), so `features/peers` hands its component to
 * this top-level slot at boot and `features/hosts` draws whatever is in it —
 * the same shape as `sessionBudgetDoor.ts`. Empty (a build without the
 * feature) ⇒ the Hosts sheet draws no entry.
 */
import type { ComponentType } from "react";
import type { SessionInfo } from "@waterplane/shared";
import { createStore, useStore } from "./sdk/store.ts";

export interface PeersSheetProps { onClose: () => void }

const slot = createStore<{ Sheet: ComponentType<PeersSheetProps> } | null>(null);

export function setPeersSheet(Sheet: ComponentType<PeersSheetProps> | null): void {
  slot.set(Sheet ? { Sheet } : null);
}

export function usePeersSheet(): ComponentType<PeersSheetProps> | null {
  return useStore(slot)?.Sheet ?? null;
}

/**
 * Activity's "peer jobs" section, the same way: `features/peers` hands it over
 * at boot and `ActivitySheet.tsx` (outside every feature) draws whatever is
 * here. Empty ⇒ no section.
 */
export interface PeerJobsSectionProps {
  sessions: readonly SessionInfo[];
  onOpenSession: (sessionId: string) => void;
}

const jobsSlot = createStore<{ Section: ComponentType<PeerJobsSectionProps> } | null>(null);

export function setPeerJobsSection(Section: ComponentType<PeerJobsSectionProps> | null): void {
  jobsSlot.set(Section ? { Section } : null);
}

export function usePeerJobsSection(): ComponentType<PeerJobsSectionProps> | null {
  return useStore(jobsSlot)?.Section ?? null;
}
