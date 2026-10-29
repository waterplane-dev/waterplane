/**
 * `gh pr list --json number,title,headRefName,url,reviewDecision,statusCheckRollup,
 * mergeable,autoMergeRequest` → PullRequestView[]. The ONE place a PR's blocker is
 * worded, so the host's notification and the phone's card never word it twice.
 * Pure; anything unreadable is ABSENT (a row without number/title/url is dropped).
 */
import type { BranchRules } from "./branchmode.js";
import type { PrCheck, PrCheckState, PrReviewDecision, PullRequestView } from "./wire/pullrequest.js";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function checkOf(c: unknown): PrCheck | undefined {
  if (!isObj(c)) return undefined;
  const name = str(c.name) ?? str(c.context);
  if (!name) return undefined;
  let state: PrCheckState;
  if (str(c.__typename) === "StatusContext" || (c.context !== undefined && c.status === undefined)) {
    const s = String(c.state ?? "").toUpperCase();
    state = s === "SUCCESS" ? "passed" : s === "FAILURE" || s === "ERROR" ? "failed" : s === "PENDING" || s === "EXPECTED" ? "running" : "skipped";
  } else {
    const status = String(c.status ?? "").toUpperCase();
    const concl = String(c.conclusion ?? "").toUpperCase();
    if (status && status !== "COMPLETED") state = "running";
    else if (concl === "SUCCESS") state = "passed";
    else if (concl === "FAILURE" || concl === "TIMED_OUT" || concl === "STARTUP_FAILURE" || concl === "CANCELLED" || concl === "ACTION_REQUIRED") state = "failed";
    else if (concl === "NEUTRAL" || concl === "SKIPPED" || concl === "STALE") state = "skipped";
    else state = status === "COMPLETED" ? "skipped" : "running";
  }
  const url = str(c.detailsUrl) ?? str(c.targetUrl);
  return url ? { name, state, url } : { name, state };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Why this PR cannot merge right now, in one sentence; absent when nothing known blocks it. */
export function prBlockedBy(p: Pick<PullRequestView, "checks" | "mergeable" | "reviewDecision">, rules?: BranchRules): string | undefined {
  if (p.mergeable === false) return "it has merge conflicts with the base branch";
  const req = rules?.requiredChecks ?? [];
  // With named required checks only those block; otherwise any failed check is worth naming.
  const counts = (c: PrCheck) => req.length === 0 || req.includes(c.name);
  const failed = p.checks.find((c) => c.state === "failed" && counts(c));
  if (failed) return `check ${failed.name} failed`;
  if (p.checks.some((c) => c.state === "running" && counts(c))) return "checks still running";
  const missing = req.find((n) => !p.checks.some((c) => c.name === n));
  if (missing) return `waiting for check ${missing}`;
  if (p.reviewDecision === "CHANGES_REQUESTED") return "a reviewer asked for changes";
  if (p.reviewDecision === "REVIEW_REQUIRED") return `waiting for ${plural(Math.max(1, rules?.requiredApprovals ?? 1), "approval")}`;
  return undefined;
}

export function prViewsFrom(raw: unknown, rules?: BranchRules): PullRequestView[] {
  if (!Array.isArray(raw)) return [];
  const out: PullRequestView[] = [];
  for (const r of raw) {
    if (!isObj(r)) continue;
    const url = str(r.url), title = typeof r.title === "string" ? r.title : undefined;
    const number = typeof r.number === "number" && Number.isInteger(r.number) && r.number > 0 ? r.number : undefined;
    if (!url || title === undefined || number === undefined) continue;
    const rd = str(r.reviewDecision);
    const reviewDecision = rd === "APPROVED" || rd === "CHANGES_REQUESTED" || rd === "REVIEW_REQUIRED" ? (rd as PrReviewDecision) : undefined;
    const checks = (Array.isArray(r.statusCheckRollup) ? r.statusCheckRollup : []).map(checkOf).filter((c): c is PrCheck => !!c);
    const m = str(r.mergeable);
    const mergeable = m === "MERGEABLE" ? true : m === "CONFLICTING" ? false : undefined;
    const v: PullRequestView = { number, title, url, headRefName: str(r.headRefName) ?? "", checks, autoMerge: isObj(r.autoMergeRequest) };
    if (reviewDecision) v.reviewDecision = reviewDecision;
    if (mergeable !== undefined) v.mergeable = mergeable;
    const blockedBy = prBlockedBy(v, rules);
    if (blockedBy) v.blockedBy = blockedBy;
    out.push(v);
  }
  return out;
}

/** The Actions run id in a check URL (`…/actions/runs/<id>/job/<n>`); absent for any other link. */
export function actionsRunId(url: string | undefined): string | undefined {
  return url ? /\/actions\/runs\/(\d+)/.exec(url)?.[1] : undefined;
}

export type PrChangeKind = "checks-failed" | "changes-requested" | "gone";
export interface PrChange { number: number; title: string; kind: PrChangeKind; url: string; detail?: string }

/** What a poll saw move between two readings. The first reading (no `prev`) reports nothing. */
export function prChanges(prev: readonly PullRequestView[] | undefined, next: readonly PullRequestView[]): PrChange[] {
  if (!prev) return [];
  const out: PrChange[] = [];
  const now = new Map(next.map((p) => [p.number, p]));
  for (const o of prev) {
    const n = now.get(o.number);
    if (!n) { out.push({ number: o.number, title: o.title, url: o.url, kind: "gone" }); continue; }
    const failedNow = n.checks.filter((c) => c.state === "failed");
    const failedBefore = new Set(o.checks.filter((c) => c.state === "failed").map((c) => c.name));
    const fresh = failedNow.find((c) => !failedBefore.has(c.name));
    if (fresh) out.push({ number: n.number, title: n.title, url: n.url, kind: "checks-failed", detail: fresh.name });
    if (n.reviewDecision === "CHANGES_REQUESTED" && o.reviewDecision !== "CHANGES_REQUESTED") out.push({ number: n.number, title: n.title, url: n.url, kind: "changes-requested" });
  }
  return out;
}
