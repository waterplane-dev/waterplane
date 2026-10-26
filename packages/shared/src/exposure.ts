/**
 * The exposure watch as the phone and the CLI both read it (`tools/exposure.mjs` writes the rows,
 * the host serves them as setup-checklist rows, the phone draws them). What a person has accepted
 * is decided HERE and nowhere else: if the CLI and the phone each carried a copy of "is this accept
 * still live", one would call a finding accepted while the other pages about it.
 *
 * Pure, no clock (the caller passes `now`), no file reads. A source the CLI could not read is
 * `absent` and stays visible as such: absent is never a pass and never a zero.
 */
import type { ComplianceAcceptRequest, ComplianceCheck } from "./wire/repo.js";

export type Severity = "critical" | "high" | "moderate" | "low" | "info";
/** An accept lasts until a newer version / a date / the reading changes (`change` = the finding's
 *  text at accept time). Every condition it names must hold; none means forever. */
export type ExposureUntil = { version?: string } | { date?: string } | { change?: string };
export interface ExposureAccept { reason: string; at: string; until?: ExposureUntil }
export interface ExposureFinding {
  key: string;
  measure: string;
  subject: string;
  version?: string;
  level: "alert" | "digest";
  severity?: Severity;
  direct?: boolean;
  text: string;
  sources: string[];
  advisory?: string;
  since?: string;
  accepted?: ExposureAccept;
}
/** A measure the run could not read: never a pass, never a zero. */
export interface ExposureAbsent { measure: string; why: string; unreachable: boolean }
export interface ExposureRow {
  v: 1;
  at: string;
  repo: string;
  dir: string;
  head?: string;
  findings: ExposureFinding[];
  absent: ExposureAbsent[];
  readings: { installScripts?: string[]; settings?: Record<string, string>; licences?: string[]; stores?: Record<string, string> };
  only?: string[];
  firstRun?: true;
}

/** Built-in accepts, merged UNDER the accepts file's (the file wins). Keys are what parse.mjs emits. */
export const PRE_ACCEPTED: Record<string, ExposureAccept> = {
  "A2:node-pty": { reason: "node-pty is pinned to a pre-release on purpose (SECURITY.md)", at: "2026-10-26" },
  "A5:web-push": { reason: "MPL-2.0, accepted on purpose", at: "2026-10-26" },
};

/** Semver-ish compare (-1/0/1); a pre-release sorts below its release, `v` and `+build` ignored. */
export function semverCmp(a: string, b: string): number {
  const split = (s: string) => {
    const [core = "", ...rest] = String(s).trim().replace(/^v/, "").split("+")[0]!.split("-");
    return { nums: core.split(".").map((n) => parseInt(n, 10) || 0), pre: rest.length ? rest.join("-").split(".") : null };
  };
  const x = split(a), y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) { if (+p !== +q) return +p < +q ? -1 : 1; }
    else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

const toMs = (d: Date | string): number => (d instanceof Date ? d.getTime() : Date.parse(d));

/** Is this accept still live for this finding? Every condition it names must hold; none => forever. */
export function acceptLive(f: ExposureFinding, a: ExposureAccept, now: Date | string): boolean {
  const u = a.until as { version?: string; date?: string; change?: string } | undefined;
  if (!u) return true;
  if (u.version !== undefined && f.version && semverCmp(f.version, u.version) > 0) return false;
  if (u.date !== undefined && !(toMs(u.date) > toMs(now))) return false;
  if (u.change !== undefined && u.change !== f.text) return false;
  return true;
}

/** Set `accepted` on every finding with a live accept; PRE_ACCEPTED sits under the file's (file wins). */
export function applyAccepts(
  findings: ExposureFinding[],
  accepts: Record<string, ExposureAccept> | null | undefined,
  now: Date | string,
): ExposureFinding[] {
  const all: Record<string, ExposureAccept> = { ...PRE_ACCEPTED, ...(accepts ?? {}) };
  // A key that embeds its version (`A3:left-pad@1.2.3`) changes on every patch release, so an
  // accept "until a version newer than X" is also found by its stem, `A3:left-pad`.
  const byStem = new Map<string, ExposureAccept>();
  for (const [k, a] of Object.entries(all)) {
    const stem = exposureVersionStem(k);
    if (stem && (a.until as { version?: string } | undefined)?.version !== undefined) byStem.set(stem, a);
  }
  return findings.map((f) => {
    let a: ExposureAccept | undefined = Object.hasOwn(all, f.key) ? all[f.key] : undefined;
    if (!a) {
      const stem = exposureVersionStem(f.key);
      a = stem ? byStem.get(stem) : undefined;
    }
    if (!a || !acceptLive(f, a, now)) { const { accepted: _x, ...rest } = f; return rest; }
    return { ...f, accepted: { reason: a.reason, at: a.at, ...(a.until ? { until: a.until } : {}) } };
  });
}

/** `<measure>:<subject>@<version>` without its `@<version>`; null for `adv:` keys and keys with no version. */
export function exposureVersionStem(key: string): string | null {
  if (key.startsWith("adv:")) return null;
  const colon = key.indexOf(":");
  const at = key.lastIndexOf("@");
  return colon > 0 && at > colon + 1 ? key.slice(0, at) : null;
}

/** The last parseable JSON line of a JSONL string; a torn last line (a crash mid-append) is skipped. */
export function readLastRow(text: string | null | undefined): ExposureRow | null {
  const lines = String(text ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.trim()) continue;
    try {
      const v = JSON.parse(lines[i]!);
      if (v && typeof v === "object") return v as ExposureRow;
    } catch { /* torn line: try the one before */ }
  }
  return null;
}

/**
 * The line each measure crosses, in words, for the row's detail. Code defaults, one phrase per
 * measure id the collector emits; a measure not listed has NO threshold text (absent, never made up).
 */
export const EXPOSURE_THRESHOLD: Record<string, string> = {
  A1: "a published advisory against an installed version",
  A2: "a stable release newer than a pre-release pin",
  A3: "a direct dependency marked deprecated",
  A4: "a package that gained an install script",
  A5: "a licence off the allow-list",
  A6: "a dependency a major version behind",
  A7: "a runtime within 90 days of end of life",
  B1: "an open Dependabot alert (high or critical, or open over 14 days)",
  B2: "secret scanning or push protection changed, or a new alert",
  B3: "Dependabot security updates changed",
  B4: "branch protection on main changed",
  B5: "the workflow token default became write",
  B6: "the organisation's 2FA requirement changed",
  B7: "a repo with dependency manifests and no Dependabot config",
  C1: "the published npm package no longer verifies",
  C2: "a release asset or the APK signer does not match",
  C3: "the Marketplace listing is behind the latest release or unlisted",
  C5: "a privacy-policy URL does not answer 200",
  C6: "the domain expires within 45 days",
  C7: "npm 2FA and the trusted publisher not confirmed by hand for 12 months",
  D1: "targetSdk below the API Play requires within 60 days",
  D2: "a user-perceived crash rate over 1.09% or ANR rate over 0.47%",
  D3: "a Connect IQ crash group the ERA check reports, or one that grew tenfold",
};

export const EXPOSURE_SUMMARY_ID = "exposure";
/**
 * The fix the `B4:default-branch` finding (no ruleset, no protection) offers: the host creates the
 * owner's two standard rulesets on GitHub (`protectmain.ts`). Confirm-gated — it changes the remote.
 */
export const PROTECT_MAIN_FIX = "protect-main";
const PROTECT_MAIN_KEY = "B4:default-branch";
/**
 * The fix every open D3 (Connect IQ crash group) finding offers: the host runs the daily runner's
 * `era-seen`, which has the ERA checker record EVERY group it lists as seen (its own `--mark-seen`;
 * a group that grows or recurs comes back) and then reads again. One button per row, one effect for
 * all of them — the confirm words say "every". Confirm-gated: it marks findings handled in bulk.
 */
export const ERA_SEEN_FIX = "era-seen";
const CHECK_PREFIX = "exposure:";
/**
 * Whether a checklist row belongs to the readings sheet's `watch` region (the daily outside view:
 * advisories, stores, Scorecard) rather than the set-up conventions. The ONE spelling of the split —
 * both regions, their counts and their bulk buttons cut on it.
 */
export const isWatchCheck = (c: ComplianceCheck): boolean =>
  c.watch === true || !!c.exposure || c.id === EXPOSURE_SUMMARY_ID;
/** The finding key inside a check id (inverse of `exposureCheckId`); null when the id is not one. */
export const exposureKeyOf = (id: string): string | null =>
  id.startsWith(CHECK_PREFIX) && id.length > CHECK_PREFIX.length ? id.slice(CHECK_PREFIX.length) : null;
/** The checklist row id of one finding: the prefix is how the host knows an accept request is ours. */
export const exposureCheckId = (key: string): string => CHECK_PREFIX + key;

const DAY_MS = 86_400_000;

/** "3 hours ago" / "2 days ago": plain words, no precision a daily job cannot back up. */
function ageWords(ms: number): string {
  if (ms < 90 * 60_000) return `${Math.max(1, Math.round(ms / 60_000))} minutes ago`;
  if (ms < 36 * 3_600_000) return `${Math.round(ms / 3_600_000)} hours ago`;
  return `${Math.round(ms / DAY_MS)} days ago`;
}

/**
 * One exposure row as setup-checklist rows: a summary first, then one per finding. Accepted
 * findings are still sent (marked `accepted`); the phone draws them folded, so "stop accepting"
 * never has to guess what the row would have said.
 */
export function exposureChecks(
  row: ExposureRow,
  name: string,
  accepts: Record<string, ExposureAccept> | null,
  now: Date | string,
  opts?: { staleMs?: number },
): ComplianceCheck[] {
  const staleMs = opts?.staleMs ?? 2 * DAY_MS;
  const findings = applyAccepts(row.findings ?? [], accepts, now);
  const open = findings.filter((f) => !f.accepted);
  const alerts = open.filter((f) => f.level === "alert").length;
  const digest = open.length - alerts;
  const accepted = findings.length - open.length;
  const absent = row.absent ?? [];

  const age = toMs(now) - Date.parse(row.at);
  const known = Number.isFinite(age);
  const fresh = known && age <= staleMs;
  const parts = [
    known ? `Read ${ageWords(Math.max(0, age))}${fresh ? "" : " (older than the daily reading should be)"}.` : "When this was read is unknown.",
    `${alerts} open alert${alerts === 1 ? "" : "s"}, ${digest} to consider, ${accepted} accepted.`,
    ...absent.map((a) => `Not measured, ${a.measure}: ${a.why}.`),
  ];
  const out: ComplianceCheck[] = [{
    id: EXPOSURE_SUMMARY_ID, label: "Exposure watch", status: fresh && !absent.length ? "pass" : "warn",
    detail: parts.join(" "), fix: null, advisory: true,
  }];

  for (const f of findings) {
    const check: ComplianceCheck = {
      id: exposureCheckId(f.key),
      label: `${f.measure} ${f.subject}${f.version ? "@" + f.version : ""}`,
      status: f.level === "alert" ? (f.severity === "critical" || f.severity === "high" ? "fail" : "warn") : "warn",
      detail: f.text,
      fix: f.accepted ? null : f.key === PROTECT_MAIN_KEY ? PROTECT_MAIN_FIX : f.measure === "D3" ? ERA_SEEN_FIX : null,
      ...(f.level === "digest" ? { advisory: true as const } : {}),
    };
    if (f.accepted) {
      const builtIn = Object.hasOwn(PRE_ACCEPTED, f.key) && !(accepts && Object.hasOwn(accepts, f.key));
      check.accepted = { ...f.accepted, ...(builtIn ? { builtIn: true as const } : {}) };
    }
    const threshold = Object.hasOwn(EXPOSURE_THRESHOLD, f.measure) ? EXPOSURE_THRESHOLD[f.measure] : undefined;
    check.exposure = {
      key: f.key, name, measure: f.measure, subject: f.subject,
      ...(f.version ? { version: f.version } : {}),
      ...(f.severity ? { severity: f.severity } : {}),
      level: f.level, sources: f.sources,
      ...(f.since ? { since: f.since } : {}),
      ...(threshold ? { threshold } : {}),
    };
    out.push(check);
  }
  return out;
}

/** Validate one accept request body: ours, with words for why not. Nothing is stored here. */
export function cleanAcceptRequest(
  body: unknown,
  now: Date | string = new Date(),
): { ok: true; value: ComplianceAcceptRequest } | { ok: false; error: string } {
  const no = (error: string) => ({ ok: false as const, error });
  if (!body || typeof body !== "object" || Array.isArray(body)) return no("Send an object with an id and accept.");
  const b = body as Record<string, unknown>;
  const id = b.id;
  if (typeof id !== "string" || !id.startsWith(CHECK_PREFIX) || id.length === CHECK_PREFIX.length) {
    return no("That row is not an exposure finding; only those can be accepted.");
  }
  if (typeof b.accept !== "boolean") return no("Say whether to accept (true) or stop accepting (false).");
  if (!b.accept) return { ok: true, value: { id, accept: false } };
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (!reason) return no("Say why you accept it: a reason is required.");
  if (reason.length > 500) return no("Keep the reason under 500 characters.");
  const value: ComplianceAcceptRequest = { id, accept: true, reason };
  if (b.until !== undefined && b.until !== null) {
    const u = b.until;
    if (typeof u !== "object" || Array.isArray(u)) return no("until must be a version, a date or a change.");
    const keys = Object.keys(u as object);
    if (keys.length !== 1) return no("Give exactly one end for the accept: a version, a date or a change.");
    const [k] = keys;
    const v = (u as Record<string, unknown>)[k!];
    if (k === "version") {
      if (typeof v !== "string" || !v.trim()) return no("The version to accept up to is empty.");
      const ver = v.trim();
      if (ver.length > 64 || !/^v?\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]+)?$/.test(ver)) {
        return no("That does not read as a version (like 2.0.0, at most 64 characters).");
      }
      value.until = { version: ver };
    } else if (k === "date") {
      const ms = typeof v === "string" ? Date.parse(v) : NaN;
      if (!Number.isFinite(ms)) return no("That date does not read as a date.");
      if (!(ms > toMs(now))) return no("That date is already past; pick one in the future.");
      value.until = { date: v as string };
    } else if (k === "change") {
      if (v !== true) return no("change must be true.");
      value.until = { change: true };
    } else return no("until must be a version, a date or a change.");
  }
  return { ok: true, value };
}
