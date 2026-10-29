/**
 * The sheet's two host calls. Neither is queued: a pick replayed later is a
 * pick for a week that may be over (the host binds it to the reset it sees).
 */
import type { WeekBurnStatus } from "@waterplane/shared";
import { core } from "../../sdk";
import { api } from "../../api";
import { SAME_AS_LAST_TOAST, savedToast } from "./logic";

export type WeekBurnPost = { repos?: string[]; recurring?: boolean; stopPct?: number; sameAsLast?: true; task?: string; notes?: Record<string, string> };

/** Post the pick; resolves with the host's new status, or null after saying why it did not land. */
export async function saveWeekBurn(body: WeekBurnPost, pickedCount: number): Promise<WeekBurnStatus | null> {
  const c = core();
  try {
    const next = await api.postWeekBurn(body);
    c.say.toast(body.sameAsLast ? SAME_AS_LAST_TOAST : savedToast(pickedCount, next.plan?.startAt));
    return next;
  } catch (e) {
    c.say.toast(`Not saved: ${e instanceof Error ? e.message : "the desktop did not answer"}`);
    return null;
  }
}
