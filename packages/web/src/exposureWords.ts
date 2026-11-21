// The exposure watch's sentences on the phone — pure, so a test pins them and the card, the
// accept form and the counts say the same thing. The rows themselves are the host's
// (`ComplianceCheck` with `exposure` / `accepted`); nothing here measures anything.
import { EXPOSURE_SUMMARY_ID, triageWords, type ComplianceAcceptRequest, type ComplianceCheck, type ComplianceTriageRequest, type ExposureTriage, crashOfGroup, crashOfSubject, crashTitle } from "@waterplane/shared";
export { crashOfGroup, crashOfSubject, crashTitle };

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

/** The card's meta line: the line it crossed, how bad, since when. Where it came from is `exposureSource`. */
export function exposureMeta(e: Exposure): string {
  const parts: string[] = [];
  if (e.threshold) parts.push(e.threshold);
  if (e.severity) parts.push(e.severity);
  if (e.since) parts.push(`since ${e.since.slice(0, 10)}`);
  return parts.join(" · ");
}

/**
 * The collector's source names (`tools/exposure/`) in words a person can place. A name not listed
 * here is printed as it arrived: the collector's own word beats a guess.
 */
const SOURCE_WORDS: Record<string, string> = {
  era: "Garmin's ERA crash reports from people's devices",
  osv: "the OSV advisory database",
  dependabot: "GitHub's Dependabot alerts",
  "secret scanning": "GitHub's secret scanning",
  "code scanning": "GitHub's code scanning",
  "openssf scorecard": "OpenSSF Scorecard",
  "github branch rules": "GitHub's branch rules",
  "github actions settings": "GitHub's Actions settings",
  "Play Developer Reporting": "Google Play's crash and ANR reporting",
  "build-files": "this repo's build files",
  "repo files": "this repo's files",
  lockfile: "this repo's lockfile",
  marketplace: "the VS Code Marketplace listing",
  "npm view": "the npm registry",
  "npm-verify": "npm's package verification",
  "release assets": "the GitHub release's assets",
  apksigner: "the APK's signature",
  rdap: "the domain's RDAP record",
  http: "a live request to the URL",
  manual: "your own confirmation",
};

/** The card's source line, or null for a row that names no source (`unreachable` rows). */
export function exposureSource(e: Exposure): string | null {
  if (!e.sources.length) return null;
  const words = e.sources.map((s) => (Object.hasOwn(SOURCE_WORDS, s) ? SOURCE_WORDS[s] : s));
  return `Source: ${words.join(", ")}, read by the exposure watch on this desktop.`;
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

export type TriageState = "seen" | "investigating" | "fixed";
export const TRIAGE_STATES: { key: TriageState; label: string; hint: string }[] = [
  { key: "seen", label: "seen", hint: "Still counted. Quiet for this app version; a newer version alerts again." },
  { key: "investigating", label: "investigating", hint: "Still counted. Quiet for this app version; a newer version alerts again." },
  { key: "fixed", label: "fixed", hint: "Older versions stop counting; the same crash in this version or newer alerts as a regression. Needs an app version on the finding." },
];
export const TRIAGE_NO_VERSION = "Type the version that carries the fix, like 1.4.2.";
export const TRIAGE_BAD_VERSION = "A version is letters, digits and . + - only, up to 32 characters.";
export const TRIAGE_BAD_COMMIT = "A commit is 7 to 40 hex characters.";
export const TRIAGE_LONG_NOTE = "The note is up to 280 characters.";

/** The sentence that replaces the submit verb while the mark form is not ready; null = ready. Mirrors the host. */
export function triageRefusal(state: TriageState, fixedIn: string, commit: string, note: string): string | null {
  if (note.trim().length > 280) return TRIAGE_LONG_NOTE;
  if (state !== "fixed") return null;
  const v = fixedIn.trim();
  if (!v) return TRIAGE_NO_VERSION;
  if (v.length > 32 || !/^[0-9A-Za-z.+-]+$/.test(v)) return TRIAGE_BAD_VERSION;
  const c = commit.trim();
  if (c && !/^[0-9a-fA-F]{7,40}$/.test(c)) return TRIAGE_BAD_COMMIT;
  return null;
}

/** The request the mark form sends (the host re-checks all of it). */
export function triageRequest(id: string, state: TriageState, fixedIn: string, commit: string, note: string): ComplianceTriageRequest {
  return {
    id, state,
    ...(state === "fixed" ? { fixedIn: fixedIn.trim() } : {}),
    ...(state === "fixed" && commit.trim() ? { commit: commit.trim() } : {}),
    ...(note.trim() ? { note: note.trim() } : {}),
  };
}

export const clearTriageRequest = (id: string): ComplianceTriageRequest => ({ id, clear: true });

/** What a card's mark control offers: the opener's verb, whether Clear mark shows, and the one line the
 *  control adds. seen / investigating are already in the card's detail (the host appends the words), so
 *  only a fixed mark adds its line here — a fact is said once. */
export function triageControl(c: ComplianceCheck): { open: string; canClear: boolean; line: string | null; offerFixed: boolean; noFixedWhy: string | null } {
  const t = c.exposure?.triage;
  const offerFixed = !!c.exposure?.appVersion;
  const noFixedWhy = offerFixed ? null : TRIAGE_NO_FIXED_WHY;
  if (!t) return { open: "Mark…", canClear: false, line: null, offerFixed, noFixedWhy };
  // A regression card's text already says "crashes again in <version>"; the mark line would say it twice.
  const regression = c.detail.includes("crashes again in");
  return { open: "Change mark…", canClear: true, line: t.state === "fixed" && !regression ? triageWords(t) : null, offerFixed, noFixedWhy };
}
export const TRIAGE_NO_FIXED_WHY = "Fixed needs an app version; Accept it instead.";

/** An accepted row the host made from a fixed mark (`accepted.byMark`), as opposed to a person's accept
 *  that a mark sits beside. Only the first reads "Clear mark" in the Accepted list. */
export const acceptedByMark = (c: ComplianceCheck): boolean => !!c.accepted && !c.accepted.builtIn && c.accepted.byMark === true;

/** The `watch` region named by its comparator, as the other three are. */
export const WATCH_REGION_WORDS =
  "Against the outside world, read daily: published advisories on what is installed, deprecations, store and " +
  "Scorecard readings. A finding here counts in the repo's badge like a set-up one; an accepted one stays listed with its reason.";

/** The watch region's own head line, above its re-check. */
export const WATCH_HEAD_WORDS =
  "What the daily exposure watch and Scorecard found about this repo's dependencies, stores and published surface.";

/** The watch region's re-check: it RUNS the watch (the collector, up to minutes), not a reload. */
export const WATCH_RECHECK_LABEL = "re-check";
export const WATCH_RECHECK_TITLE = "Run the exposure watch for this repo now, then re-read its findings";
export const WATCH_RECHECK_RUNNING = "running the exposure watch for this repo — a first run can take a minute or two…";
/** No sentence came back (a lost link, an older host): said, never silent. */
export const watchRecheckFailed = (why: string): string => `The watch did not run: ${why}`;

/** The watch region's empty state: not watched, and where to turn it on (a link follows). */
export const WATCH_EMPTY_WORDS =
  "Not watched yet: the daily exposure watch has no rows for this repo, and Scorecard has no reading yet.";
export const WATCH_EMPTY_LINK = "add this repo to the exposure watch";

// ── The watch's verdict and the Connect IQ crash rows ──────────────────────────────────────────────────

/** A check's display title: a crash group by its app and error, anything else by its own label. */
export function watchRowTitle(c: ComplianceCheck): { title: string; where: string | null } {
  const crash = c.exposure ? crashOfSubject(c.exposure.subject) : null;
  return crash ? crashTitle(crash) : { title: c.label, where: null };
}

/** The collector's reason, tidied for reading: no "ERROR:" shout, no doubled full stop. Words kept. */
export function tidyWhy(why: string): string {
  let t = why.replace(/\bERROR: ?/g, "").trim();
  while (t.endsWith("..")) t = t.slice(0, -1);
  return t;
}

export type WatchTone = "ok" | "needs" | "unknown";
/** The one answer at the top of the region: is anything open today? Counted from the SAME cut the lists
 *  are drawn from (`exposureCut`), so the number is the rows below it. An unread measure is never "nothing". */
export function watchVerdict(v: { alerts: number; digest: number; marked: number; accepted: number; notMeasured: number; stale: boolean }): { tone: WatchTone; head: string } {
  if (v.alerts > 0) return { tone: "needs", head: v.alerts === 1 ? "1 open finding to look at" : `${v.alerts} open findings to look at` };
  if (v.notMeasured > 0) return { tone: "unknown", head: "Could not read everything today" };
  if (v.stale) return { tone: "unknown", head: "No fresh reading — the daily watch has not run" };
  return { tone: "ok", head: "Nothing open — all handled" };
}
/** The line under the verdict: how old, and where every other row went. Zero groups are left out. */
export function watchTally(v: { readAt: string | null; now: number; marked: number; accepted: number; digest: number }): string {
  const parts: string[] = [];
  if (v.readAt) { const a = ageWords(v.readAt, v.now); parts.push(a ? `read ${a === "today" ? hoursAgo(v.readAt, v.now) : a}` : ""); }
  if (v.marked) parts.push(`${v.marked} fixed, listed below`);
  if (v.accepted) parts.push(`${v.accepted} accepted`);
  if (v.digest) parts.push(`${v.digest} to consider`);
  return parts.filter(Boolean).join(" · ");
}
function hoursAgo(iso: string, now: number): string {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return m < 90 ? `${Math.max(1, m)} min ago` : `${Math.round(m / 60)} h ago`;
}
/** A measure the reading could not take, as one sentence. D3 is the Connect IQ crash list. */
export function notMeasuredLine(m: { measure: string; why: string }): string {
  const what = m.measure === "D3" ? "The crash list (Connect IQ ERA) could not be read" : `${m.measure} could not be read`;
  return `${what}: ${tidyWhy(m.why)}`;
}
export const NOT_MEASURED_NEXT = "Tap re-check to read it again; approve the vault card on the phone if one appears.";

/** "Marked fixed (n)": crash groups somebody marked fixed — from today's reading (old installs still report
 *  them) and from earlier readings (not in today's). One head, one explanation of the one verb. */
export const markedHead = (n: number): string => `Marked fixed (${n})`;
export const MARKED_WORDS =
  "A fix shipped for each of these. Reports from versions older than the fix are not counted; " +
  "a crash on the fixed version or newer comes back as an open finding by itself.";
export const REOPEN_LABEL = "reopen";
export const REOPEN_WORDS = "Reopen forgets the fixed mark, so the crash counts as open again.";
export const MARKED_STALE_WORDS = "not in today's crash list";
export const MARKED_UNCHECKED_WORDS = "not checked today — the crash list could not be read";
/** A fixed mark's short line: "fixed in 1.0.9 · 27 Oct" (the commit is in the note and the triage file). The note goes on its own quiet line. */
export function markShort(t: ExposureTriage): string {
  const d = Date.parse(t.at);
  const day = Number.isFinite(d) ? `${new Date(d).getUTCDate()} ${MONTHS[new Date(d).getUTCMonth()]}` : "";
  return [t.state === "fixed" ? `fixed${t.fixedIn ? ` in ${t.fixedIn}` : ""}` : t.state, day].filter(Boolean).join(" · ");
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
