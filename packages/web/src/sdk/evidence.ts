/**
 * The Setup check's evidence doors, landing ON the item. A door (`features/setupCheck`) aims ONE
 * route here and opens the target screen; the screen reads the aim at its FIRST render
 * (`useEvidenceFocus`), cuts or scrolls to it, and forgets it. Nothing is persisted: a reload
 * opens the screen as it always opens.
 *
 * The cut is a filter, so it says what it hides: `evidenceCutWords` is the one "n of N" sentence,
 * and `cutByIds` the one place the ids are applied (the number and the rows come from the same call).
 */
import { useEffect, useState } from "react";
import type { EvidenceRoute } from "@waterplane/shared";
export { cutByIds, evidenceCutWords } from "@waterplane/shared";
import { createStore } from "./store.ts";

export const evidenceFocus = createStore<EvidenceRoute | null>(null);

/** ONE writer: a door aims, then opens the screen. */
export function aimEvidence(route: EvidenceRoute | null): void {
  evidenceFocus.set(route);
}

/** What the screen was aimed at, or null (also null when the aim was for another screen). */
export function peekEvidence<S extends EvidenceRoute["screen"]>(screen: S): Extract<EvidenceRoute, { screen: S }> | null {
  const r = evidenceFocus.get();
  return r && r.screen === screen ? (r as Extract<EvidenceRoute, { screen: S }>) : null;
}

/**
 * Read once at the first render, forget in an effect (not at the read: StrictMode renders twice).
 * A screen opened by any other door starts unfiltered.
 */
export function useEvidenceFocus<S extends EvidenceRoute["screen"]>(screen: S): Extract<EvidenceRoute, { screen: S }> | null {
  const [focus] = useState(() => peekEvidence(screen));
  useEffect(() => { if (peekEvidence(screen)) evidenceFocus.set(null); }, [screen]);
  return focus;
}
