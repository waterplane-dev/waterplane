/**
 * **The draw order a stored value means** (R-queue-016): newest first unless
 * run order was picked, and only the run answer is ever stored (`"1"`), so
 * nothing stored — or anything else — is the newest-first default. Not in the
 * barrel (its export list is pinned); `useBacklogSort` imports this file.
 */
import type { BacklogSort } from "./rowSort.ts";

export function sortFromStored(stored: string | null | undefined): BacklogSort {
  return stored === "1" ? "run" : "newest";
}
