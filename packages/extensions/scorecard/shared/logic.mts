/**
 * The scorecard's pure logic, shared by the host half and (for the remedy prompt) the phone:
 * GitHub remote → slug, the API reply → checks, failing / accepted, the words of the setup row and
 * the remedy prompt. No node imports.
 */
import { BUILT_IN_ACCEPTS, SLUG_RE, type CheckView, type ScoreAccept, type ScoreCheck } from "./wire.mjs";

const DETAIL_LINES = 20;
const DETAIL_CHARS = 300;

/** GitHub `owner/name` of a remote URL (https, scp-style, ssh://, git://), or null for any other host. */
export function githubSlug(url: string): string | null {
  const m = /^(?:(?:https?|ssh|git|git\+ssh):\/\/)?(?:[^@/\s]+@)?(?:www\.)?github\.com(?::\d+)?[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (!m) return null;
  const slug = `${m[1]}/${m[2]}`;
  return isUsableSlug(slug) ? slug : null;
}

/** SLUG_RE plus the two names GitHub's regex shape admits but no repo can have ("." and ".."). */
export function isUsableSlug(s: string): boolean {
  if (!SLUG_RE.test(s)) return false;
  const name = s.slice(s.indexOf("/") + 1);
  return name !== "." && name !== "..";
}

/** Check names come off the network: only OWN keys count, so `constructor` / `__proto__` are ordinary names. */
export const own = <T,>(o: Readonly<Record<string, T>> | null | undefined, k: string): T | undefined => (o && Object.hasOwn(o, k) ? o[k] : undefined);
export const builtInAccept = (name: string): string | undefined => own(BUILT_IN_ACCEPTS, name);

/** The slug a git `config` text names: remote `origin` if it is GitHub, else the first GitHub remote. */
export function slugFromConfig(text: string): string | null {
  const remotes: { name: string; url: string }[] = [];
  let cur: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[\s*remote\s+"([^"]+)"\s*\]$/i.exec(line);
    if (sec) { cur = sec[1]!; continue; }
    if (line.startsWith("[")) { cur = null; continue; }
    const kv = /^url\s*=\s*(.+)$/i.exec(line);
    if (kv && cur !== null) remotes.push({ name: cur, url: kv[1]!.trim() });
  }
  const gh = remotes.map((r) => ({ name: r.name, slug: githubSlug(r.url) })).filter((r) => r.slug);
  return (gh.find((r) => r.name === "origin") ?? gh[0])?.slug ?? null;
}

/** Failing = it loses points: 0 <= score < 10. -1 (inconclusive) never fails. */
export const isFailing = (score: number): boolean => score >= 0 && score < 10;

export const viewerUrl = (slug: string): string => `https://scorecard.dev/viewer/?uri=github.com/${slug}`;

export interface Parsed {
  score: number;
  date?: string;
  commit?: string;
  scorecardVersion?: string;
  checks: ScoreCheck[];
}

const MAX_CHECKS = 40;
const NAME_MAX = 100;
const REASON_CAP = 500;
const SHORT_CAP = 300;
const URL_CAP = 300;
const clip = (v: string, n: number): string => (v.length > n ? v.slice(0, n - 1) + "…" : v);

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The API reply, defensively. A wrong shape is `{ ok:false, reason }` — never an invented number. */
export function parseReply(d: unknown): { ok: true; value: Parsed } | { ok: false; reason: string } {
  const o = d as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: false, reason: "the Scorecard reply was not a JSON object" };
  const score = o.score;
  if (typeof score !== "number" || !Number.isFinite(score)) return { ok: false, reason: "the Scorecard reply has no aggregate score" };
  if (score < 0 || score > 10) return { ok: false, reason: `the Scorecard reply's score (${score}) is outside 0–10` };
  if (!Array.isArray(o.checks)) return { ok: false, reason: "the Scorecard reply has no list of checks" };
  const checks: ScoreCheck[] = [];
  for (const c of o.checks) {
    if (checks.length >= MAX_CHECKS) break;
    const r = c as Record<string, unknown> | null;
    if (!r || typeof r !== "object" || typeof r.name !== "string" || !r.name || typeof r.score !== "number" || !Number.isFinite(r.score)) continue;
    const doc = r.documentation as Record<string, unknown> | null | undefined;
    const details = Array.isArray(r.details)
      ? r.details.filter((x): x is string => typeof x === "string").slice(0, DETAIL_LINES).map((x) => (x.length > DETAIL_CHARS ? x.slice(0, DETAIL_CHARS - 1) + "…" : x))
      : [];
    checks.push({
      name: clip(r.name, NAME_MAX),
      score: r.score,
      reason: clip(str(r.reason) ?? "", REASON_CAP),
      details,
      docUrl: doc && typeof doc === "object" ? clip(str(doc.url) ?? "", URL_CAP) || null : null,
      short: doc && typeof doc === "object" ? clip(str(doc.short) ?? "", SHORT_CAP) : "",
    });
  }
  if (!checks.length) return { ok: false, reason: "the Scorecard reply lists no readable check" };
  const repo = o.repo as Record<string, unknown> | null | undefined;
  const sc = o.scorecard as Record<string, unknown> | null | undefined;
  const value: Parsed = { score, checks };
  const date = str(o.date); if (date) value.date = date;
  const commit = repo && typeof repo === "object" ? str(repo.commit) : null; if (commit) value.commit = commit;
  const ver = sc && typeof sc === "object" ? str(sc.version) : null; if (ver) value.scorecardVersion = ver;
  return { ok: true, value };
}

/** A person's accept holds while the check's score has not fallen below the score it was accepted at. */
export const acceptHolds = (a: ScoreAccept, score: number): boolean => a.builtIn === true || a.score === undefined || score >= a.score;

/** The sheet's checks: each with `failing` and its accept (built-in first, else the person's, unless lapsed). */
export function checkViews(checks: readonly ScoreCheck[], person: Readonly<Record<string, ScoreAccept>> = {}): CheckView[] {
  return checks.map((c) => {
    const v: CheckView = { ...c, failing: isFailing(c.score) };
    if (!v.failing) return v;
    const built = builtInAccept(c.name);
    if (built) v.accepted = { reason: built, builtIn: true };
    else {
      const p = own(person, c.name);
      if (p && acceptHolds(p, c.score)) v.accepted = p;
    }
    return v;
  });
}

export const openCount = (checks: readonly CheckView[]): number => checks.filter((c) => c.failing && !c.accepted).length;

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The setup row's detail for a scored repo, e.g. "6/10 — 3 failing checks (A, B, C); 3 accepted". */
export function scoredDetail(score: number, checks: readonly CheckView[]): string {
  const open = checks.filter((c) => c.failing && !c.accepted);
  const accepted = checks.filter((c) => c.failing && c.accepted).length;
  if (!open.length) return `${score}/10 — no failing check left${accepted ? ` (${accepted} accepted)` : ""}`;
  const names = open.length > 6 ? `${open.slice(0, 6).map((c) => c.name).join(", ")}, …` : open.map((c) => c.name).join(", ");
  return `${score}/10 — ${plural(open.length, "failing check")} (${names})${accepted ? `; ${accepted} accepted` : ""}`;
}

const HINTS: Record<string, string> = {
  "Pinned-Dependencies": "Pin every GitHub Action by its full commit SHA, with the version as a trailing comment (`uses: actions/checkout@<40-hex-sha> # v4.2.2`); pin Docker base images by digest and install steps by hash or lockfile. Add Dependabot (`.github/dependabot.yml`, ecosystem `github-actions`) so the pins keep getting updated.",
  "Token-Permissions": "Give every workflow a top-level `permissions: read-all` (or `contents: read`) and grant write scopes only on the single job that needs them.",
  "Branch-Protection": "Needs a minimal ruleset on the default branch that blocks force-push and deletion. That takes repo admin in GitHub settings: do NOT run it yourself. Give the person the `gh api` command (a repository ruleset, or `PUT /repos/{owner}/{repo}/branches/{branch}/protection`) to run, and explain what it changes.",
  "Signed-Releases": "Sign or attest the release assets (build-provenance attestation with `actions/attest-build-provenance`, or sigstore/cosign signatures uploaded next to each release asset).",
  "SAST": "Add a CodeQL workflow (`github/codeql-action`) that runs on pull requests and pushes to the default branch.",
  "Security-Policy": "Add a SECURITY.md saying how to report a vulnerability privately and what to expect in reply.",
  "Binary-Artifacts": "Remove committed binaries (jars, executables, archives) or, where one must stay, say why it is there and where it comes from.",
  "Dependency-Update-Tool": "Add `.github/dependabot.yml` (or a Renovate config) covering every ecosystem the repo uses, including `github-actions`.",
  "Vulnerabilities": "Fix or upgrade the dependencies the details list; where an advisory cannot apply, document it in an osv-scanner config (`osv-scanner.toml` ignore with a reason).",
  "Maintained": "Scored from recent commit and issue activity on the repo's age; usually only time fixes it. Say so rather than inventing activity.",
  "CII-Best-Practices": "Needs a project page at bestpractices.dev, which only the maintainer can create and fill in; tell the person what it asks for.",
  "License": "Add a recognised license file (LICENSE or COPYING) at the repo root with an OSI-approved license text.",
  "Packaging": "Publish through a recognised packaging workflow (e.g. a GitHub Actions workflow that runs the registry's publish step); say which registry fits this repo.",
  "CI-Tests": "Make sure pull requests run the test suite in CI and that the run is visible as a check.",
  "Webhooks": "Webhooks must carry a secret; that is set in GitHub settings by a repo admin, so tell the person which webhook lacks one.",
};

/** The prompt a person taps to send the agent after one failing check. Pure; the phone may quote it. */
export function remedyPrompt(slug: string, c: ScoreCheck): string {
  const lines = [
    `The public OpenSSF Scorecard for github.com/${slug} gives the check "${c.name}" ${c.score}/10.`,
    `Reason: ${c.reason || "(none given)"}`,
  ];
  if (c.details.length) lines.push("Details:", ...c.details.map((d) => `- ${d}`));
  if (c.docUrl) lines.push(`Documentation: ${c.docUrl}`);
  const hint = own(HINTS, c.name);
  if (hint) lines.push("", `What usually fixes it: ${hint}`);
  lines.push("", `Raise this one check in this repo. Change only what "${c.name}" needs, commit, and say plainly what you could not fix (and why, for example that it needs a repo admin or a person's account).`);
  return lines.join("\n");
}
