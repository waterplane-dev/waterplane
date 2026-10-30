/**
 * The PR card's pure rules. Absent or `direct` branch rules mean exactly what the git view always drew:
 * today's push label, no card, no lease. Only a remote that demands a PR switches any of this on.
 * The one worded reason a PR cannot merge (`blockedBy`) is the host's; nothing here re-words it.
 */
import type { BranchRules, MergeMethod, PrCheck, PrReviewDecision } from "@waterplane/shared";
import { TimeoutError } from "@waterplane/shared";

/** The push button's text. Direct/absent: byte-identical to what GitView always drew. */
export function pushLabel(rules: BranchRules | undefined, ahead = 0): string {
  if (cardVisible(rules)) return "Push & open PR";
  return ahead > 0 ? `Push ${ahead}` : "Push";
}

/** The card (and its lease) exist only where the remote's rules demand a PR. */
export function cardVisible(rules: BranchRules | undefined): boolean {
  return rules?.mode === "pr" || rules?.mode === "pr-checks";
}

/** The lease is renewed this often while the card is on screen (the host lets it lapse at 60 s). */
export const LEASE_RENEW_MS = 30_000;

export interface CheckCounts { running: number; passed: number; failed: number; skipped: number }

export function checkCounts(checks: readonly PrCheck[]): CheckCounts {
  const c: CheckCounts = { running: 0, passed: 0, failed: 0, skipped: 0 };
  for (const k of checks) c[k.state]++;
  return c;
}

/** The one state the checks row leads with: a failure outranks a running check outranks green. */
export function checksState(checks: readonly PrCheck[]): "none" | "failed" | "running" | "passed" {
  const c = checkCounts(checks);
  if (c.failed) return "failed";
  if (c.running) return "running";
  return c.passed ? "passed" : "none";
}

export function checksWords(checks: readonly PrCheck[]): string {
  if (!checks.length) return "no checks reported";
  const c = checkCounts(checks);
  const parts = [c.failed && `${c.failed} failed`, c.running && `${c.running} running`, c.passed && `${c.passed} passed`, c.skipped && `${c.skipped} skipped`].filter(Boolean);
  return parts.join(" · ");
}

export function reviewWords(d: PrReviewDecision | undefined): string | null {
  if (d === "APPROVED") return "approved";
  if (d === "CHANGES_REQUESTED") return "changes requested";
  if (d === "REVIEW_REQUIRED") return "review required";
  return null;
}

/** The method a merge uses: the person's pick if the repo allows it, else the first allowed; absent = let the host decide. */
export function mergeMethod(rules: BranchRules | undefined, chosen?: MergeMethod): MergeMethod | undefined {
  const allowed = rules?.allowedMerge ?? [];
  if (chosen && allowed.includes(chosen)) return chosen;
  return allowed[0];
}

/**
 * The method auto-merge SENDS: only one the person picked (and the card still offers). With no pick it
 * sends none, so the host takes the first method from its own fresh rules — the phone's copy may be
 * older than a repo-settings change, and its first-allowed would be refused as if the person chose it.
 */
export function pickedMethod(rules: BranchRules | undefined, chosen?: MergeMethod): MergeMethod | undefined {
  return chosen && (rules?.allowedMerge ?? []).includes(chosen) ? chosen : undefined;
}

/**
 * What a PR action that got no answer says. A merge, auto-merge or close is sent and then runs `gh`
 * on the desktop for up to a minute or more: a TIMEOUT means the request left the phone and the
 * action may well have happened, so it is never worded as "did not reach" (the card refreshes its
 * list right after, which shows what really happened). Any other failure never got there.
 */
export function prActionFailWords(e: unknown): string {
  if (e instanceof TimeoutError) return "The desktop did not answer in time but it may still have worked; refreshing the list.";
  return `Did not reach the desktop: ${(e as Error)?.message ?? String(e)}`;
}
