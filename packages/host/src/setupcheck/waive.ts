/**
 * Waive (or take back) one REPO finding, on the store that finding already answers to:
 *  - an advisory setup check keeps its ignore (`setCheckIgnored`);
 *  - an exposure watch row keeps its accept (`setCheckAccepted`: the accepts file the release gate reads,
 *    with a reason, and ending when the finding changes), never a plain waiver that hides a security finding forever;
 *  - every other repo finding (overlaps, permissions, health) is waived for THIS repo in the prefs store.
 * A take-back clears every store the row could be set aside in, and says so in words when it cannot
 * (a built-in accept lives in source).
 */
import type { RepoTarget } from "@waterplane/shared";
import { checkIdOfFinding } from "./readers.js";

type Out = { ok: true } | { ok: false; error: string };
export interface WaiveIo {
  ignore(target: RepoTarget, checkId: string, on: boolean): { ok: boolean; error?: string };
  accept(target: RepoTarget, req: { id: string; accept: boolean; reason?: string; until?: { change: true } }): { ok: boolean; error?: string };
  /** Is this exposure check already accepted (on the exposure screen)? Optional: absent = not known. */
  isAccepted?(target: RepoTarget, checkId: string): boolean;
  prefs: {
    waivedFindings(worktree?: string): Record<string, unknown>;
    setRepoWaived(worktree: string, id: string, w: { reason?: string; at: string } | null): Out;
  };
}
export interface WaiveReq { id: string; waive: boolean; reason?: string }

const EXPOSURE = "exposure:";

export function waiveRepoFinding(target: RepoTarget, io: WaiveIo, b: WaiveReq): Out {
  const { id, waive, reason } = b;
  const checkId = checkIdOfFinding(id);
  const accepts = !!checkId && checkId.startsWith(EXPOSURE);
  const stamp = () => ({ at: new Date().toISOString(), ...(reason ? { reason } : {}) });
  if (waive) {
    if (accepts) {
      // An accept the person already made (their own reason and end) stays as it is: a second write would replace it.
      if (io.isAccepted?.(target, checkId)) return { ok: true };
      // The card's tap is the person's say; with no typed reason it is named so. It ends when the finding changes.
      const r = io.accept(target, { id: checkId, accept: true, reason: reason || "Set aside from the Setup check.", until: { change: true } });
      return r.ok ? { ok: true } : { ok: false, error: r.error ?? "refused" };
    }
    if (checkId && io.ignore(target, checkId, true).ok) return { ok: true };
    return io.prefs.setRepoWaived(target.worktreePath, id, stamp());
  }
  const hadWaiver = Object.hasOwn(io.prefs.waivedFindings(target.worktreePath), id);
  const cleared = io.prefs.setRepoWaived(target.worktreePath, id, null);
  // An exposure key may carry `#`, which the prefs store refuses: no waiver can exist for it, so the accept below is the take-back.
  if (!cleared.ok && !accepts) return cleared;
  if (checkId && !accepts) io.ignore(target, checkId, false);
  if (accepts) {
    const r = io.accept(target, { id: checkId, accept: false });
    if (!r.ok && !hadWaiver) return { ok: false, error: r.error ?? "refused" };
  }
  return { ok: true };
}
