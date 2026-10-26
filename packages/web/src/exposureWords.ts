// The exposure watch's sentences on the phone — pure, so a test pins them and the card, the
// accept form and the counts say the same thing. The rows themselves are the host's
// (`ComplianceCheck` with `exposure` / `accepted`); nothing here measures anything.
import { EXPOSURE_SUMMARY_ID, type ComplianceAcceptRequest, type ComplianceCheck } from "@waterplane/shared";

type Exposure = NonNullable<ComplianceCheck["exposure"]>;
type Accepted = NonNullable<ComplianceCheck["accepted"]>;

/**
 * ONE function feeds every count and every list on this subject. An accepted row is in
 * `accepted` and nowhere else; a digest row is `digest` and not in `alerts`; `summary` is the
 * `exposure` row. Non-exposure rows are in none of them.
 */
type Bucket = "summary" | "accepted" | "digest" | "alerts" | null;
/** The ONE bucketing: which group of the exposure cut a row belongs to (null: not an exposure row). */
function bucketOf(c: ComplianceCheck): Bucket {
  if (c.id === EXPOSURE_SUMMARY_ID) return "summary";
  if (!c.exposure) return null;
  if (c.accepted) return "accepted";
  return c.exposure.level === "digest" ? "digest" : "alerts";
}

export function exposureCut(checks: readonly ComplianceCheck[]) {
  const alerts: ComplianceCheck[] = [];
  const digest: ComplianceCheck[] = [];
  const accepted: ComplianceCheck[] = [];
  let summary: ComplianceCheck | null = null;
  for (const c of checks) {
    const b = bucketOf(c);
    if (b === "summary") summary = c;
    else if (b === "accepted") accepted.push(c);
    else if (b === "digest") digest.push(c);
    else if (b === "alerts") alerts.push(c);
  }
  return { alerts, digest, accepted, summary };
}

/** Whether a row is drawn by the main list: everything except the groups with their own heads
 *  (accepted, digest) — the same bucketing as `exposureCut`. */
export const inExposureMainList = (c: ComplianceCheck): boolean => {
  const b = bucketOf(c);
  return b !== "accepted" && b !== "digest";
};

/** The digest group's head. Its rows count in nothing, and the head says so. */
export function digestHead(n: number): string {
  return `Digest · ${n} — counted in nothing`;
}
export const acceptedHead = (n: number): string => `Accepted (${n})`;

/** The card's meta line: the line it crossed, how bad, where it was read, since when. */
export function exposureMeta(e: Exposure): string {
  const parts: string[] = [];
  if (e.threshold) parts.push(e.threshold);
  if (e.severity) parts.push(e.severity);
  if (e.sources.length) parts.push(`from ${e.sources.join(", ")}`);
  if (e.since) parts.push(`since ${e.since.slice(0, 10)}`);
  return parts.join(" · ");
}

type Until = Accepted["until"] | ComplianceAcceptRequest["until"];

/** How long an accept holds. `change` is the reading's text on the host and `true` on the wire. */
export function untilWords(until: Until): string {
  if (until && "version" in until && until.version) return `ends once a version newer than ${until.version} is installed`;
  if (until && "date" in until && until.date) return `until ${until.date}`;
  if (until && "change" in until && until.change) return "until the reading changes";
  return "for good";
}

const DAY = 86_400_000;
function ageWords(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = Math.max(0, Math.floor((now - t) / DAY));
  return d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
}

/** The accepted card's line: who/what said it, why, how long, when. */
export function acceptedLine(a: Accepted, now: number): string {
  if (a.builtIn) return `Accepted in code — ${a.reason}`;
  const age = ageWords(a.at, now);
  return `Accepted${age ? ` ${age}` : ""}: ${a.reason} (${untilWords(a.until)})`;
}
export const BUILT_IN_WORDS = "accepted in code";

export type UntilChoice = "change" | "date" | "version";

/** The accept form's choices. The version one is offered only when `untilVersionOffered`. */
export function untilChoices(offerVersion: string | null) {
  const out: { key: UntilChoice; label: string }[] = [
    { key: "change", label: "until the reading changes" },
    { key: "date", label: "until a date" },
  ];
  if (offerVersion) out.push({ key: "version", label: `ends once a version newer than the one you type is installed (now ${offerVersion})` });
  return out;
}

/** The version a finding sits at, or null: the host refuses a version condition on a finding
 *  that carries none, so the choice is not drawn for it. */
export function untilVersionOffered(c: ComplianceCheck): string | null {
  return c.exposure?.version?.trim() || null;
}

export const ACCEPT_NO_REASON = "Say why you accept it — the reason stays with the row.";
export const ACCEPT_NO_DATE = "Pick the date the accept ends.";
export const ACCEPT_NO_VERSION = "Type the newest version you accept; the accept ends once a newer one is installed.";

/** The sentence that replaces the submit verb while the form is not ready; null = ready. */
export function acceptRefusal(reason: string, choice: UntilChoice, value: string): string | null {
  if (!reason.trim()) return ACCEPT_NO_REASON;
  if (choice === "date" && !value.trim()) return ACCEPT_NO_DATE;
  if (choice === "version" && !value.trim()) return ACCEPT_NO_VERSION;
  return null;
}

/** The request the form sends (the host re-checks all of it). */
export function acceptRequest(id: string, reason: string, choice: UntilChoice, value: string): ComplianceAcceptRequest {
  const until = choice === "date" ? { date: value.trim() }
    : choice === "version" ? { version: value.trim() }
    : { change: true as const };
  return { id, accept: true, reason: reason.trim(), until };
}

/** The `watch` region named by its comparator, as the other three are. */
export const WATCH_REGION_WORDS =
  "Against the outside world, read daily: published advisories on what is installed, deprecations, store and " +
  "Scorecard readings. A finding here counts in the repo's badge like a set-up one; an accepted one stays listed with its reason.";

/** The watch region's own head line, above its re-check. */
export const WATCH_HEAD_WORDS =
  "What the daily exposure watch and Scorecard found about this repo's dependencies, stores and published surface.";

/** The watch region's empty state: not watched, and where to turn it on (a link follows). */
export const WATCH_EMPTY_WORDS =
  "Not watched yet: the daily exposure watch has no rows for this repo, and Scorecard has no reading yet.";
export const WATCH_EMPTY_LINK = "add this repo to the exposure watch";

/** The findings cut's tail in one region, when the badge's count also holds findings in the other. */
export function cutElsewhereWords(n: number, region: "watch" | "setup"): string {
  return `${n} more ${n === 1 ? "finding is" : "findings are"} under ${region === "watch" ? "watch" : "set-up"}`;
}
