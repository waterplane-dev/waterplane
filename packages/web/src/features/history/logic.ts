/**
 * The history feature's words, pure (`logic.test.mjs`).
 */

/** The receipt for a pin tap: pinning names what it became, null unpins. */
export function pinToast(entryId: string | null): string {
  return entryId ? "pinned as overview label" : "unpinned";
}
