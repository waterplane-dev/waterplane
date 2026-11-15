/**
 * "Open this archived conversation in the reader" — asked by one feature (session search's
 * archived hit), answered by another (the archive sheet in `features/tools`). Features never
 * import each other, so the ask lives here: a one-slot store the archive sheet reads on open and
 * clears on leave, the same lifetime as the tools feature's strip focuses.
 */
import type { ArchivedConversation } from "@waterplane/shared";
import { core, createStore } from "./sdk";

export const archiveOpen = createStore<{ repoId: string; row: ArchivedConversation } | undefined>(undefined);

/** Open the archive on one conversation, straight in its read-only reader. */
export function openArchivedConversation(repoId: string, row: ArchivedConversation): void {
  const c = core();
  c.say.track("overlay:archive");
  archiveOpen.set({ repoId, row });
  c.nav.open("archive");
}
