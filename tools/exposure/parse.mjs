// Pure parsers of the exposure watch: every function takes an already-fetched payload (npm audit
// JSON, a lockfile, a registry document, a gh API reply, a Gradle file …) and returns findings,
// readings or absences. No process, no network, no file reads, no dependency (the two TOML formats
// we meet are read by a minimal hand parser below); `now` comes in as a parameter wherever time
// matters. The CLI (tools/exposure.mjs) fetches, these decide. A reading that cannot be had comes
// back as an `absent` entry, never as a pass and never as a zero.
import { createHash } from "node:crypto";

/** The licences that need no look. Anything else (or none declared) is an A5 alert. */
export const ALLOW_LICENCES = ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "CC0-1.0", "BlueOak-1.0.0"];

const DAY = 86400000;

// ---- small helpers -------------------------------------------------------------------------

/** Dedupe/accept key — the same rule as core.mjs's findingKey (kept local so the two files stand alone). */
function keyOf({ measure, subject, version, advisory }) {
  if (advisory) return `adv:${advisory}:${subject}`;
  return `${measure}:${subject}${version ? `@${version}` : ""}`;
}

/** Build a finding with its key; `alert` unless told otherwise. */
function finding(f) {
  const out = { level: "digest", sources: [], ...f };
  out.key = keyOf(out);
  return out;
}

const absent = (measure, why, unreachable = false) => ({ measure, why, unreachable });

/** npm/GitHub/OSV severity words → our five. `medium` is `moderate`; unknown is null. */
function sev(s) {
  const v = String(s ?? "").toLowerCase();
  if (v === "medium") return "moderate";
  return ["critical", "high", "moderate", "low", "info"].includes(v) ? v : null;
}
const isHigh = (s) => s === "high" || s === "critical";

/** [major, minor, patch, prerelease[]] of a version string; null when it is not semver-shaped. */
function semver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v ?? ""));
  return m ? { core: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split(".") : [] } : null;
}

/** -1/0/1 by semver precedence (a release outranks its own pre-releases); null if either is unparsable. */
function cmpVersion(a, b) {
  const x = semver(a), y = semver(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return +p < +q ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// ---- npm: lockfile, audit, registry -----------------------------------------------------------

/**
 * Packages of a lockfileVersion 2/3 `packages` map. `direct` = hoisted at `node_modules/<name>` AND
 * named by the root manifest (or by a workspace's own manifest — those are ours too). Symlink
 * entries (`link: true`) are skipped: their target has its own entry.
 */
export function parseLockfile(json) {
  const map = json?.packages ?? {};
  const wanted = new Set();
  for (const [path, e] of Object.entries(map)) {
    if (path !== "" && path.includes("node_modules/")) continue; // only root + workspace manifests
    for (const k of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const n of Object.keys(e?.[k] ?? {})) wanted.add(n);
    }
  }
  const packages = [];
  for (const [path, e] of Object.entries(map)) {
    if (path === "" || e?.link) continue;
    const i = path.lastIndexOf("node_modules/");
    const name = i >= 0 ? path.slice(i + "node_modules/".length) : (e.name ?? path);
    const lic = e.license;
    packages.push({
      name,
      version: e.version ?? null,
      path,
      dev: !!(e.dev || e.devOptional),
      hasInstallScript: !!e.hasInstallScript,
      license: typeof lic === "string" ? lic : (lic?.type ?? null),
      direct: path === `node_modules/${name}` && wanted.has(name),
      workspace: !path.includes("node_modules/"), // our own package (a workspace), not a dependency
    });
  }
  return { packages };
}

/**
 * A1 findings from `npm audit --json` (v7+ `vulnerabilities` map). One per (advisory, package) from
 * `via` OBJECTS (those carry the advisory url); `via` strings only point at another entry and produce
 * nothing themselves. Alert when high/critical, or moderate on a direct dependency; else digest.
 */
export function npmAuditFindings(auditJson, lockLabel, directNames = new Set()) {
  const out = new Map();
  for (const [entryName, v] of Object.entries(auditJson?.vulnerabilities ?? {})) {
    for (const via of v?.via ?? []) {
      if (typeof via !== "object" || !via?.url) continue;
      const subject = via.name ?? entryName;
      const advisory = /advisories\/(GHSA-[\w-]+)/i.exec(via.url)?.[1] ?? `npm:${via.source}`;
      const severity = sev(via.severity) ?? sev(v.severity) ?? "moderate";
      const direct = directNames.has(subject);
      const f = finding({
        measure: "A1", subject, advisory, severity, direct,
        level: isHigh(severity) || (severity === "moderate" && direct) ? "alert" : "digest",
        text: `${via.title ?? advisory} (${severity}${direct ? ", direct" : ", transitive"}) in ${subject}${via.range ? ` ${via.range}` : ""}.`,
        sources: [`npm audit ${lockLabel}`],
      });
      if (!out.has(f.key)) out.set(f.key, f);
    }
  }
  return [...out.values()];
}

/** B1 findings from `GET /repos/{r}/dependabot/alerts?state=open`: alert if high/critical or open > 14 days. */
export function dependabotFindings(alertsJson, now = new Date()) {
  const out = new Map();
  for (const a of Array.isArray(alertsJson) ? alertsJson : []) {
    if (a.state && a.state !== "open") continue;
    const advisory = a.security_advisory?.ghsa_id;
    const subject = a.dependency?.package?.name ?? a.security_vulnerability?.package?.name;
    if (!advisory || !subject) continue;
    const severity = sev(a.security_vulnerability?.severity ?? a.security_advisory?.severity) ?? "moderate";
    const days = a.created_at ? Math.floor((new Date(now) - new Date(a.created_at)) / DAY) : 0;
    const f = finding({
      measure: "B1", subject, advisory, severity,
      level: isHigh(severity) || days > 14 ? "alert" : "digest",
      text: `Dependabot alert #${a.number ?? "?"}: ${a.security_advisory?.summary ?? advisory} (${severity}), open ${days} day${days === 1 ? "" : "s"}.`,
      sources: ["dependabot"],
    });
    if (!out.has(f.key)) out.set(f.key, f);
  }
  return [...out.values()];
}

/**
 * A2/A3/A6 from an abbreviated npm packument (`dist-tags`, `versions[v].deprecated`).
 *  A2 — `declared` is an exact PRE-release pin: a stable `latest` newer than it ⇒ alert; a newer
 *       pre-release on the same channel (`-beta.15` → `-beta.18`) ⇒ digest. Subject = name, no version.
 *  A3 — the installed version is deprecated: direct ⇒ alert, transitive ⇒ digest.
 *  A6 — a direct dependency whose declared major is below latest's ⇒ digest (the CLI only counts them).
 */
export function registryFindings(doc, { name, installed, declared, direct = false }) {
  const out = [];
  const latest = doc?.["dist-tags"]?.latest;
  const src = [`registry ${name}`];
  const pin = typeof declared === "string" && /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(declared) ? declared : null;
  if (pin) {
    if (latest && !semver(latest)?.pre.length && cmpVersion(latest, pin) === 1) {
      out.push(finding({ measure: "A2", subject: name, level: "alert", sources: src,
        text: `${name} is pinned to the pre-release ${pin}; the stable ${latest} is out.` }));
    } else {
      const chan = semver(pin).pre[0];
      let best = null;
      for (const v of Object.keys(doc?.versions ?? {})) {
        if (semver(v)?.pre[0] === chan && cmpVersion(v, pin) === 1 && (!best || cmpVersion(v, best) === 1)) best = v;
      }
      if (best) out.push(finding({ measure: "A2", subject: name, level: "digest", sources: src,
        text: `${name} is pinned to ${pin}; a newer ${chan} pre-release, ${best}, is out.` }));
    }
  }
  const dep = installed ? doc?.versions?.[installed]?.deprecated : null;
  if (dep) {
    out.push(finding({ measure: "A3", subject: name, version: installed, direct, level: direct ? "alert" : "digest", sources: src,
      text: `${name}@${installed} is deprecated: ${String(dep).slice(0, 160)}` }));
  }
  if (direct && declared && latest) {
    const dm = /(\d+)/.exec(String(declared)), lm = semver(latest);
    if (dm && lm && +dm[1] < lm.core[0]) {
      out.push(finding({ measure: "A6", subject: name, direct, level: "digest", sources: src,
        text: `${name} is declared ${declared}; latest is ${latest} (${lm.core[0] - +dm[1]} major behind).` }));
    }
  }
  return out;
}

/** True when an SPDX expression is acceptable: any OR branch whose AND-parts are all on the list. */
function licenceOk(expr, allow) {
  const ok = new Set(allow);
  return String(expr).replace(/[()]/g, " ").split(/\s+OR\s+/i)
    .some((branch) => branch.split(/\s+AND\s+/i).every((p) => ok.has(p.trim())));
}

/** A5: an alert per package (by name, however many versions) whose licence is off the list or missing. */
export function licenceFindings(packages, allow = ALLOW_LICENCES) {
  const out = new Map();
  for (const p of packages ?? []) {
    if (p.workspace) continue; // first-party: its licence is ours to declare, not a dependency's
    const lic = p.license ? String(p.license).trim() : "";
    if (lic && licenceOk(lic, allow)) continue;
    const f = finding({
      measure: "A5", subject: p.name, level: "alert", sources: ["package-lock.json"],
      text: lic ? `${p.name} is licensed ${lic}, which is not on the allow-list.` : `${p.name}: no licence declared.`,
    });
    if (!out.has(f.key)) out.set(f.key, f);
  }
  return [...out.values()];
}

// ---- minimal TOML (Gradle version catalog, pyproject) ------------------------------------------

/** Drop a `# comment` that sits outside quotes. */
function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === "\\" && q === '"') i++; else if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

/** Bracket depth change of a text, ignoring brackets inside quotes. */
function depthDelta(s) {
  let q = null, d = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === "\\" && q === '"') i++; else if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === "[" || c === "{") d++;
    else if (c === "]" || c === "}") d--;
  }
  return d;
}

/** Split on `sep` outside quotes and brackets. */
function splitTop(s, sep = ",") {
  const parts = [];
  let q = null, d = 0, cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === "\\" && q === '"') cur += s[++i] ?? ""; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === "[" || c === "{") d++;
    else if (c === "]" || c === "}") d--;
    if (c === sep && d === 0) { parts.push(cur); cur = ""; } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** A TOML value (string, array, inline table, bare scalar); dotted inline keys (`version.ref`) nest. */
function tomlValue(raw) {
  const s = raw.trim();
  if (s.startsWith('"') || s.startsWith("'")) return s.slice(1, -1);
  if (s.startsWith("[")) return splitTop(s.slice(1, -1)).map(tomlValue);
  if (s.startsWith("{")) {
    const o = {};
    for (const kv of splitTop(s.slice(1, -1))) {
      const eq = kv.indexOf("=");
      if (eq < 0) continue;
      const path = kv.slice(0, eq).trim().split(".").map((k) => k.trim());
      let at = o;
      for (const k of path.slice(0, -1)) at = at[k] = typeof at[k] === "object" ? at[k] : {};
      at[path.at(-1)] = tomlValue(kv.slice(eq + 1));
    }
    return o;
  }
  return s;
}

/** `{ "[section]": { key: value } }` — enough TOML for the two files we read; multi-line arrays joined. */
function tomlLite(text) {
  const doc = {};
  let sec = "", pending = null;
  for (const line0 of String(text).split(/\r?\n/)) {
    const line = stripComment(line0);
    if (pending) {
      pending.raw += ` ${line.trim()}`;
      if (depthDelta(pending.raw) <= 0) { doc[sec][pending.key] = tomlValue(pending.raw); pending = null; }
      continue;
    }
    const h = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (h) { sec = h[1].trim(); doc[sec] ??= {}; continue; }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, ""), raw = line.slice(eq + 1).trim();
    doc[sec] ??= {};
    if (depthDelta(raw) > 0) pending = { key, raw };
    else doc[sec][key] = tomlValue(raw);
  }
  return doc;
}

// ---- Gradle ------------------------------------------------------------------------------------

/**
 * `"group:artifact:version"` literals from a build.gradle(.kts). A coordinate with no version, a
 * `$var`/`${…}` version or a dynamic `+` version is skipped (nothing definite to look up); `//` comment
 * lines are ignored; a trailing `:classifier` is dropped.
 */
export function parseGradleDeps(text) {
  const seen = new Map();
  const re = /["']([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+):([^"'\s:]+)(?::[^"'\s]*)?["']/g;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*\/\//.test(line)) continue;
    for (const m of line.matchAll(re)) {
      if (/[$+]/.test(m[3])) continue;
      seen.set(`${m[1]}:${m[2]}:${m[3]}`, { group: m[1], artifact: m[2], version: m[3] });
    }
  }
  return [...seen.values()];
}

/**
 * `gradle/libs.versions.toml` → coordinates. `[versions]` names resolve `version.ref`; a library may be
 * `"g:a:v"`, `{ module = "g:a", version = "1" }`, `{ group, name, version.ref }`. A library with no
 * version (BOM-managed) comes back with `version: null` — osvQueries reports it as unversioned.
 */
export function parseVersionCatalog(tomlText) {
  const doc = tomlLite(tomlText);
  const versions = {};
  for (const [k, v] of Object.entries(doc.versions ?? {})) {
    versions[k] = typeof v === "string" ? v : (v?.strictly ?? v?.require ?? v?.prefer ?? null);
  }
  const out = [];
  for (const v of Object.values(doc.libraries ?? {})) {
    let group, artifact, version = null;
    if (typeof v === "string") [group, artifact, version = null] = v.split(":");
    else if (v && typeof v === "object") {
      if (v.module) [group, artifact] = String(v.module).split(":");
      else { group = v.group; artifact = v.name; }
      const ver = v.version;
      if (typeof ver === "string") version = ver;
      else if (ver?.ref) version = versions[ver.ref] ?? null;
      else if (ver) version = ver.strictly ?? ver.require ?? ver.prefer ?? null;
    }
    if (group && artifact) out.push({ group, artifact, version });
  }
  return out;
}

// ---- pyproject ---------------------------------------------------------------------------------

/**
 * `[project] dependencies` and `[project.optional-dependencies]` → `{name, spec, floor}`. `floor` is the
 * lowest version the spec admits: `==` (`.*` dropped), else `~=`, else `>=`; null when the spec has none
 * of those (only `<`, `<=`, `>`, `!=`, or nothing) — an upper bound alone says nothing about what runs.
 */
export function parsePyproject(tomlText) {
  const doc = tomlLite(tomlText);
  const reqs = [...(doc.project?.dependencies ?? [])];
  for (const arr of Object.values(doc["project.optional-dependencies"] ?? {})) reqs.push(...(Array.isArray(arr) ? arr : []));
  const out = [];
  for (const r of reqs) {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([^;]*)/.exec(String(r));
    if (!m) continue;
    const spec = m[2].trim();
    const clauses = spec.split(",").map((c) => /^(==|~=|>=)\s*([0-9][^\s,]*)/.exec(c.trim())).filter(Boolean);
    const pick = ["==", "~=", ">="].map((op) => clauses.find((c) => c[1] === op)).find(Boolean);
    out.push({ name: m[1], spec, floor: pick ? pick[2].replace(/\.\*$/, "") : null });
  }
  return out;
}

// ---- OSV ---------------------------------------------------------------------------------------

/** What to look up for a dep: Maven `{group, artifact, version}` or PyPI `{name, floor}`. */
const osvName = (d) => (d.group ? `${d.group}:${d.artifact}` : d.name);
const osvVersion = (d) => d.version ?? d.floor ?? null;

/**
 * `POST /v1/querybatch` body. `queried` is the deps that went into it, in query order (pass it back to
 * osvFindings as `deps`); `unversioned` is the rest — report those absent, never as clean.
 */
export function osvQueries(deps, ecosystem) {
  const queried = [], unversioned = [];
  for (const d of deps ?? []) (osvVersion(d) ? queried : unversioned).push(d);
  return {
    body: { queries: queried.map((d) => ({ package: { name: osvName(d), ecosystem }, version: osvVersion(d) })) },
    queried, unversioned,
  };
}

/** CVSS v3.x base score of a vector string; null for anything else (v4 and friends are not computed). */
function cvss3(vector) {
  if (!/^CVSS:3\.[01]\//.test(vector)) return null;
  const m = Object.fromEntries(vector.split("/").slice(1).map((p) => p.split(":")));
  const changed = m.S === "C";
  const AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[m.AV], AC = { L: 0.77, H: 0.44 }[m.AC];
  const PR = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 }[m.PR], UI = { N: 0.85, R: 0.62 }[m.UI];
  const cia = (k) => ({ H: 0.56, L: 0.22, N: 0 })[m[k]];
  if ([AV, AC, PR, UI, cia("C"), cia("I"), cia("A")].some((x) => x === undefined)) return null;
  const iss = 1 - (1 - cia("C")) * (1 - cia("I")) * (1 - cia("A"));
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  if (impact <= 0) return 0;
  const raw = (changed ? 1.08 : 1) * (impact + 8.22 * AV * AC * PR * UI);
  return Math.ceil(Math.min(raw, 10) * 10) / 10;
}

/** Severity of an OSV record: GHSA-style label, else a CVSS bucket, else "moderate". */
function osvSeverity(v) {
  const label = sev(v?.database_specific?.severity);
  if (label) return label;
  for (const s of v?.severity ?? []) {
    const n = /^\d+(\.\d+)?$/.test(String(s.score)) ? +s.score : cvss3(String(s.score));
    if (n !== null && n !== undefined) return n >= 9 ? "critical" : n >= 7 ? "high" : n >= 4 ? "moderate" : "low";
  }
  return "moderate";
}

const SEV_ORDER = ["info", "low", "moderate", "high", "critical"];
const looseParts = (v) => String(v ?? "").replace(/^v/i, "").split(/[^0-9]+/).filter(Boolean).map(Number);
/** Dotted-number compare for PyPI/Maven versions ("10.0" vs "10.3.1"); suffixes like rc1 are ignored. */
function cmpLoose(a, b) {
  const x = looseParts(a), y = looseParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
const normPkg = (n) => String(n ?? "").toLowerCase().replace(/[-_.]+/g, "-");

/** The first version above `floor` that an OSV record says fixes `pkg`; null when it names none. */
function firstFixAbove(v, pkg, floor) {
  const fixes = [];
  for (const a of v?.affected ?? []) {
    if (normPkg(a?.package?.name) !== normPkg(pkg)) continue;
    for (const r of a.ranges ?? []) for (const e of r.events ?? []) if (e.fixed) fixes.push(e.fixed);
  }
  const above = fixes.filter((f) => cmpLoose(f, floor) > 0).sort(cmpLoose);
  return above[0] ?? null;
}

/**
 * A1 findings from a querybatch reply. `deps` = the `queried` list (same order as the queries);
 * `vulnDetails` maps an OSV id → its `/v1/vulns/<id>` record; an id with no record is skipped (the
 * caller reports the failed lookup as absent — a guessed severity would be a wrong number). Advisory
 * id = a GHSA alias when there is one, else the OSV id. Every dep is one we declare, so high/critical
 * and moderate alert (the same rule as a direct npm dependency); low is a digest line.
 * An exact-version dep (Maven) gets one finding per advisory. A dep queried by a declared FLOOR
 * (pyproject range) gets ONE finding `A1:<name>@<floor>`: its severity is the highest of the advisories,
 * `advisories` lists them, and the text names the lowest version that fixes all (or "unknown").
 */
export function osvFindings(batchResp, deps, vulnDetails = {}) {
  const out = new Map();
  (batchResp?.results ?? []).forEach((r, i) => {
    const d = deps?.[i];
    if (!d) return;
    const floorDep = d.version == null && d.floor != null;
    const subject = osvName(d), ver = osvVersion(d);
    const group = [];
    for (const { id } of r?.vulns ?? []) {
      const v = vulnDetails[id];
      if (!v) continue;
      const advisory = (v.aliases ?? []).find((a) => /^GHSA-/.test(a)) ?? (/^GHSA-/.test(id) ? id : v.id ?? id);
      const severity = osvSeverity(v);
      if (floorDep) { group.push({ advisory, severity, fix: firstFixAbove(v, subject, ver) }); continue; }
      const f = finding({
        measure: "A1", subject, version: ver, advisory, severity, direct: true,
        level: isHigh(severity) || severity === "moderate" ? "alert" : "digest",
        text: `${v.summary ?? advisory} (${severity}) in ${subject}@${ver}.`,
        sources: ["osv"],
      });
      if (!out.has(f.key)) out.set(f.key, f);
    }
    if (!group.length) return;
    const severity = group.reduce((m, g) => (SEV_ORDER.indexOf(g.severity) > SEV_ORDER.indexOf(m) ? g.severity : m), "info");
    const advisories = [...new Set(group.map((g) => g.advisory))].sort();
    const fixAll = group.some((g) => !g.fix) ? null : group.map((g) => g.fix).sort(cmpLoose).at(-1);
    const f = finding({
      measure: "A1", subject, version: ver, severity, direct: true, advisories,
      level: isHigh(severity) || severity === "moderate" ? "alert" : "digest",
      text: `declared floor ${subject} ${ver} admits ${advisories.length} known advisor${advisories.length === 1 ? "y" : "ies"} (highest: ${severity}); lowest version fixing all: ${fixAll ?? "unknown"}`,
      sources: ["osv"],
    });
    if (!out.has(f.key)) out.set(f.key, f);
  });
  return [...out.values()];
}

// ---- GitHub repo settings ------------------------------------------------------------------------

/**
 * B2–B6 readings plus B7. Inputs are raw gh API replies (null/undefined = not readable with this token):
 *  repo = GET /repos/{r}; workflowPerms = GET …/actions/permissions/workflow; protection = branch
 *  protection of the default branch (null = none); rulesets = GET …/rulesets; org = GET /orgs/{o}.
 * `settings` values are strings (B2 "scanning on, push protection off", B3 on/off, B4 none/protection/
 * ruleset (when gh cannot read it, "none"/"protection" from `scorecardBranch`, provenance in `notes.B4` = {source, score, date}, never in the diffed value), B5 read/write, B6 on/off) for the next run to diff; a setting that cannot be read is in
 * `absent`, not in `settings`. B5 "write" is an alert finding every run; B7 is a digest finding.
 */
export function ghRepoSettings({ repo, workflowPerms, protection, rulesets, org, dependabotConfigPresent, hasManifests, scorecardBranch }) {
  const settings = {}, notes = {}, findings = [], abs = [];
  const sa = repo?.security_and_analysis;
  const st = (o) => o?.status;
  if (st(sa?.secret_scanning)) {
    settings.B2 = `scanning ${st(sa.secret_scanning) === "enabled" ? "on" : "off"}, push protection ${st(sa.secret_scanning_push_protection) === "enabled" ? "on" : "off"}`;
  } else abs.push(absent("B2", "secret scanning is not readable with this token"));
  if (st(sa?.dependabot_security_updates)) settings.B3 = st(sa.dependabot_security_updates) === "enabled" ? "on" : "off";
  else abs.push(absent("B3", "Dependabot security updates are not readable with this token"));
  if (protection === undefined && rulesets === undefined) {
    // gh could not read it: OpenSSF Scorecard's public Branch-Protection check is the fallback reading
    const sc = scorecardBranch;
    if (sc && typeof sc.score === "number" && sc.score >= 0) {
      settings.B4 = sc.score === 0 ? "none" : "protection"; // same vocabulary as the gh path: a re-score must not read as a change
      notes.B4 = { source: "scorecard", score: sc.score, date: sc.date ?? null };
    } else abs.push(absent("B4", sc === undefined
      ? "branch protection is not readable with this token"
      : "branch protection is not readable with this token, and Scorecard's Branch-Protection check is inconclusive or not scored"));
  } else settings.B4 = protection ? "protection" : Array.isArray(rulesets) && rulesets.length ? "ruleset" : "none";
  if (settings.B4 === "none") {
    findings.push(finding({ measure: "B4", subject: "default-branch", level: "digest", sources: [notes.B4 ? "openssf scorecard" : "github branch rules"],
      text: "The default branch has no ruleset and no branch protection: a force-push or a deletion of it would go through." }));
  }
  const perm = workflowPerms?.default_workflow_permissions;
  if (perm) {
    settings.B5 = perm;
    if (perm === "write") {
      findings.push(finding({ measure: "B5", subject: "default_workflow_permissions", level: "alert", sources: ["github actions settings"],
        text: "Workflows get read-write GITHUB_TOKEN permissions by default." }));
    }
  } else abs.push(absent("B5", "default workflow permissions are not readable with this token"));
  if (repo && repo.owner?.type !== "Organization") abs.push(absent("B6", "the repo is not owned by an organisation"));
  else if (typeof org?.two_factor_requirement_enabled === "boolean") settings.B6 = org.two_factor_requirement_enabled ? "on" : "off";
  else abs.push(absent("B6", "two-factor requirement is not readable with this token"));
  if (hasManifests && !dependabotConfigPresent) {
    findings.push(finding({ measure: "B7", subject: "dependabot.yml", level: "digest", sources: ["repo files"],
      text: "The repo has dependency manifests but no .github/dependabot.yml." }));
  }
  return { settings, notes, findings, absent: abs };
}

/** B2 alert per open secret-scanning alert. */
export function secretScanningFindings(alertsJson) {
  const out = [];
  for (const a of Array.isArray(alertsJson) ? alertsJson : []) {
    if (a.state && a.state !== "open") continue;
    out.push(finding({
      measure: "B2", subject: `secret-scanning#${a.number}`, level: "alert", sources: ["secret scanning"],
      text: `Open secret-scanning alert #${a.number}: ${a.secret_type_display_name ?? a.secret_type ?? "secret"}.`,
    }));
  }
  return out;
}

// ---- end of life ------------------------------------------------------------------------------

/**
 * A7 from endoflife.date `/api/<product>.json`: an alert when the cycle for `minMajor` reaches its end
 * of life within 90 days (or already has). Returns `{findings, absent}`; an unknown cycle is absent.
 */
export function eolFindings(cycles, product, minMajor, now = new Date()) {
  const c = (Array.isArray(cycles) ? cycles : []).find((x) => String(x.cycle) === String(minMajor));
  if (!c) return { findings: [], absent: [absent("A7", `${product} ${minMajor} is not listed by endoflife.date`)] };
  if (c.eol === true) {
    return { findings: [finding({ measure: "A7", subject: product, version: String(minMajor), level: "alert", sources: ["endoflife.date"],
      text: `${product} ${minMajor} is end of life (no date listed).` })], absent: [] };
  }
  const t = typeof c.eol === "string" ? Date.parse(c.eol) : NaN;
  if (Number.isNaN(t)) return { findings: [], absent: [] }; // eol false/absent: no date to cross
  const days = Math.ceil((t - new Date(now)) / DAY);
  if (days > 90) return { findings: [], absent: [] };
  return {
    findings: [finding({
      measure: "A7", subject: product, version: String(minMajor), level: "alert", sources: ["endoflife.date"],
      text: days < 0 ? `${product} ${minMajor} reached end of life on ${c.eol}.` : `${product} ${minMajor} reaches end of life on ${c.eol} (${days} day${days === 1 ? "" : "s"}).`,
    })],
    absent: [],
  };
}

// ---- what we publish ----------------------------------------------------------------------------

/** Maintainer names, sorted, from `["name <mail>"]` or `[{name}]`. */
const maintainerNames = (m) => (m ?? []).map((x) => (typeof x === "string" ? x.replace(/\s*<.*$/, "") : x?.name)).filter(Boolean).sort();

/**
 * C1 from `npm view <pkg> --json`: a deprecated latest ⇒ alert. `readings` = `{maintainers, distTags}`
 * for core to diff run over run (keys "C1.maintainers"/"C1.distTags"). With `expectMaintainers` /
 * `expectDistTags` (arrays of names), anyone / any tag outside them is an alert at once.
 */
export function npmPublishedFindings(viewJson, { expectMaintainers, expectDistTags } = {}) {
  const name = viewJson?.name ?? "package";
  const distTags = viewJson?.["dist-tags"] ?? {};
  const maintainers = maintainerNames(viewJson?.maintainers);
  const findings = [];
  const mk = (subject, text) => findings.push(finding({ measure: "C1", subject: `npm:${name}${subject}`, level: "alert", sources: ["npm view"], text }));
  const dep = viewJson?.deprecated ?? viewJson?.versions?.[distTags.latest]?.deprecated;
  if (dep) mk("", `${name}@${distTags.latest ?? "latest"} is marked deprecated: ${String(dep).slice(0, 160)}`);
  if (expectMaintainers) {
    const extra = maintainers.filter((m) => !expectMaintainers.includes(m));
    if (extra.length) mk(":maintainers", `${name} has unexpected maintainers: ${extra.join(", ")}.`);
  }
  if (expectDistTags) {
    const extra = Object.keys(distTags).filter((t) => t !== "latest" && !expectDistTags.includes(t));
    if (extra.length) mk(":dist-tags", `${name} has unexpected dist-tags: ${extra.join(", ")}.`);
  }
  return { findings, readings: { maintainers, distTags } };
}

/**
 * C3 from the Marketplace `extensionquery` reply: not found / flagged unpublished ⇒ alert; a listed
 * version other than `localVersion`, once the local version is over 7 days old, ⇒ alert (the upload
 * did not land, or someone else's did).
 */
export function marketplaceFindings(queryResp, { localVersion, localVersionDate, now = new Date(), name } = {}) {
  const ext = queryResp?.results?.[0]?.extensions?.[0];
  const subject = `marketplace:${name ?? ext?.extensionName ?? "extension"}`;
  const mk = (text) => finding({ measure: "C3", subject, level: "alert", sources: ["marketplace"], text });
  if (!ext) return [mk("The extension is not found on the Marketplace.")];
  if (/unpublished/i.test(String(ext.flags ?? ""))) return [mk("The extension is flagged unpublished on the Marketplace.")];
  const listed = ext.versions?.[0]?.version;
  const age = localVersionDate ? (new Date(now) - new Date(localVersionDate)) / DAY : 0;
  if (listed && localVersion && listed !== localVersion && age > 7) {
    return [mk(`The Marketplace lists ${listed}, but the local version ${localVersion} is ${Math.floor(age)} days old.`)];
  }
  return [];
}

/**
 * C2: each `<asset>.sha256` in `files` (name → Buffer|string) against sha256 of `<asset>`. The digest is
 * the first 64-hex token of the .sha256 file. An unreadable .sha256 or a missing asset also alerts.
 */
export function sha256Mismatches(files) {
  const out = [];
  const bytes = (x) => (typeof x === "string" ? Buffer.from(x) : x);
  for (const [n, body] of Object.entries(files ?? {})) {
    if (!n.endsWith(".sha256")) continue;
    const asset = n.slice(0, -".sha256".length);
    const mk = (text) => out.push(finding({ measure: "C2", subject: asset, level: "alert", sources: ["release assets"], text }));
    const want = /\b[0-9a-f]{64}\b/i.exec(bytes(body).toString("utf8"))?.[0]?.toLowerCase();
    if (!want) { mk(`${n} holds no sha256 digest.`); continue; }
    if (!(asset in files)) { mk(`${n} has no ${asset} beside it.`); continue; }
    const got = createHash("sha256").update(bytes(files[asset])).digest("hex");
    if (got !== want) mk(`${asset} hashes to ${got.slice(0, 12)}…, its .sha256 says ${want.slice(0, 12)}….`);
  }
  return out;
}

/**
 * C2 from `apksigner verify --print-certs` output: the signer's SHA-256 against the expected one
 * (case and colons ignored). Returns `{findings, absent}`; no such line in the output is absent.
 */
export function apkCertFinding(apksignerStdout, expectedSha256) {
  const m = /Signer #1 certificate SHA-256 digest:\s*([0-9A-Fa-f:]+)/.exec(String(apksignerStdout ?? ""));
  if (!m) return { findings: [], absent: [absent("C2", "apksigner printed no signer certificate digest")] };
  const norm = (s) => String(s).replace(/[:\s]/g, "").toLowerCase();
  if (norm(m[1]) === norm(expectedSha256)) return { findings: [], absent: [] };
  return {
    findings: [finding({ measure: "C2", subject: "apk-signer", level: "alert", sources: ["apksigner"],
      text: `The APK is signed with ${norm(m[1]).slice(0, 12)}…, not the expected certificate.` })],
    absent: [],
  };
}

/** C1 alert from a failed `npm-verify.mjs <pkg> <version> --check`: its FAIL lines (or its last line) are the reading. */
export function npmVerifyFinding(pkg, version, stdout) {
  const lines = String(stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const fails = lines.filter((l) => /fail/i.test(l));
  const why = (fails.length ? fails : lines.slice(-1)).join("; ").slice(0, 300) || "no output";
  return finding({ measure: "C1", subject: `npm:${pkg}:verify`, version, level: "alert", sources: ["npm-verify"],
    text: `npm-verify --check failed for ${pkg}@${version}: ${why}` });
}

// ---- phase 3: C5-C7 (outside-the-repo upkeep), D1 (Play target API), D3 (Connect IQ crash groups) ------------

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

/** C5: a privacy-policy URL's final reading (`{ok,status,finalUrl}` or `{ok:false,why}`); anything but 200 is a high alert, no answer is absent. */
export function privacyUrlFinding(url, res) {
  if (!res?.ok) return { findings: [], absent: [absent("C5", `${url}: ${res?.why ?? "no answer"}`, true)] };
  if (res.status === 200) return { findings: [], absent: [] };
  const via = res.finalUrl && res.finalUrl !== url ? ` (final URL ${res.finalUrl})` : "";
  return { findings: [finding({ measure: "C5", subject: url, level: "alert", severity: "high", sources: ["http"],
    text: `The privacy-policy URL answers HTTP ${res.status}, not 200${via}.` })], absent: [] };
}

/**
 * C6 from an RDAP domain object: the `expiration` event. <=45 days (or past) is an alert; the version is the
 * expiry date, so a renewal is a new key. The text carries the date only (no countdown): an "until the reading changes" accept compares it. Returns `{findings, absent, reading}` (reading = the date, for the row).
 */
export function rdapExpiryFinding(rdap, domain, now) {
  const ev = (Array.isArray(rdap?.events) ? rdap.events : []).find((e) => e?.eventAction === "expiration");
  const t = Date.parse(ev?.eventDate ?? "");
  if (!ev || Number.isNaN(t)) return { findings: [], absent: [absent("C6", `RDAP for ${domain} lists no expiration date`)] };
  const date = ymd(t), days = Math.floor((t - new Date(now).getTime()) / DAY);
  if (days > 45) return { findings: [], absent: [], reading: date };
  const text = days < 0 ? `${domain} expired on ${date}.` : `${domain} expires on ${date}.`;
  return { findings: [finding({ measure: "C6", subject: `domain:${domain}`, version: date, level: "alert", severity: days < 0 ? "critical" : "moderate", sources: ["rdap"], text })], absent: [], reading: date };
}

/**
 * C7: a check a machine cannot make (npm 2FA, the trusted publisher) is confirmed by hand with a date.
 * No date is absent with the how-to; >365 days old is an alert, 335-365 a digest; a bad or future date is `error`.
 */
export function manualConfirmFinding(pkg, dateStr, now) {
  const none = { findings: [], absent: [] };
  if (dateStr === undefined || dateStr === null || dateStr === "")
    return { ...none, absent: [absent("C7", "not confirmed by hand: check 2FA and the trusted publisher on npmjs.com, then pass --npm-2fa-confirmed <date>")] };
  const t = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr)) ? Date.parse(`${dateStr}T00:00:00Z`) : NaN;
  if (Number.isNaN(t) || ymd(t) !== dateStr) return { ...none, error: `bad --npm-2fa-confirmed ${dateStr} (want YYYY-MM-DD)` };
  const age = Math.floor((new Date(now).getTime() - t) / DAY);
  if (age < 0) return { ...none, error: `--npm-2fa-confirmed ${dateStr} is in the future` };
  const subject = `npm:${pkg}:2fa`;
  if (age > 365) return { ...none, findings: [finding({ measure: "C7", subject, level: "alert", sources: ["manual"], text: `npm 2FA and the trusted publisher: last confirmed ${dateStr}, over 12 months ago.` })] };
  if (age >= 335) return { ...none, findings: [finding({ measure: "C7", subject, level: "digest", sources: ["manual"], text: `npm 2FA and the trusted publisher: last confirmed ${dateStr}, due within 30 days.` })] };
  return none;
}

/** The tracked files D1 reads for a targetSdk: build files and top-level scripts, never a template, fixture, test or example. */
export const targetSdkFiles = (files) => files.filter((f) => !/(^|\/)(templates?|fixtures?|tests?|examples?|__tests__|testdata)\//.test(f))
  .filter((f) => /(^|\/)(build\.gradle(\.kts)?|variables\.gradle|libs\.versions\.toml|AndroidManifest\.xml)$/.test(f) || /^[^/]+\/[^/]*\.sh$|^[^/]*\.sh$/.test(f));

/**
 * The targetSdk LITERALS in tracked build files ({path,text}[]): gradle `targetSdk(Version) = 36` / `targetSdkVersion 36`,
 * a version catalog `targetSdk = "36"`, a shell build's `--target-sdk-version 36`, a manifest `android:targetSdkVersion="36"`.
 * A non-literal (`rootProject.ext.targetSdkVersion`) matches nothing here, so it resolves only through a literal
 * elsewhere (variables.gradle) and is never guessed. (Template/fixture/test/example paths are skipped by the caller.) Several values: the LOWEST, with its file. None: null.
 */
export function targetSdkReadings(files) {
  const all = [];
  for (const { path, text } of files ?? []) {
    for (const raw of String(text ?? "").split("\n")) {
      const line = raw.trim();
      if (/^(\/\/|#|\*|\/\*|<!--)/.test(line)) continue;
      for (const m of line.matchAll(/\btargetSdk(?:Version)?\b\s*[=:]?\s*["']?(\d{2,3})["']?(?![\w.])|--target-sdk-version[ =](\d{2,3})\b/g)) all.push({ value: +(m[1] ?? m[2]), file: path });
    }
  }
  if (!all.length) return null;
  const low = all.reduce((a, b) => (b.value < a.value ? b : a));
  return { value: low.value, file: low.file, all };
}

/** Play's rule: by 31 Aug of year Y, new apps and updates target API Y-1990 (2024->34, 2025->35, 2026->36). */
const PLAY_API_KNOWN = { 2024: 34, 2025: 35, 2026: 36 };
const PLAY_KNOWN_LAST = 2026;
const requiredApi = (y) => PLAY_API_KNOWN[y] ?? y - 1990;

/**
 * D1: targetSdk against Play's required API. The requirement in force is the last deadline passed (31 Aug, end of day, UTC);
 * below it is a high alert. Below the next one with it within 60 days is moderate. The version is the required API,
 * so the finding re-keys each year; a year past the known table says "expected".
 */
export function targetApiFinding(targetSdk, file, now, pkg = "app") {
  const t = new Date(now).getTime(), y = new Date(t).getUTCFullYear();
  const dl = (yr) => Date.UTC(yr, 7, 31, 23, 59, 59);
  const mk = (yr, severity, text) => finding({ measure: "D1", subject: `play:${pkg}:targetSdk`, version: String(requiredApi(yr)), level: "alert", severity, sources: ["build-files"],
    text: `${text}${yr > PLAY_KNOWN_LAST ? " (the requirement for that year is expected, not yet published)" : ""} targetSdk ${targetSdk} in ${file}.` });
  const inForce = t > dl(y) ? y : y - 1;
  if (targetSdk < requiredApi(inForce)) return [mk(inForce, "high", `Play has required API ${requiredApi(inForce)} since 31 Aug ${inForce} for new apps and updates;`)];
  const next = t > dl(y) ? y + 1 : y;
  const left = Math.floor((dl(next) - t) / DAY);
  if (targetSdk < requiredApi(next) && left <= 60) return [mk(next, "moderate", `Play requires API ${requiredApi(next)} by 31 Aug ${next};`)];
  return [];
}

/**
 * D3 from the Connect IQ ERA checker's exit code (its contract: 0 = nothing new, 10 = act, 2 = cannot reach) and output.
 * On 10, stdout is a JSON array: one alert per element ({key, app, channel, version, error, count, last, top}).
 */
export function eraFindings(status, stdout, stderr) {
  const lastErr = String(stderr ?? "").split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "no output";
  const bad = (why, unreachable = true) => ({ findings: [], absent: [absent("D3", why, unreachable)] });
  if (status === 0) return { findings: [], absent: [] };
  if (status === 2) return bad(`ERA checker could not reach its source: ${lastErr}`);
  if (status !== 10) return bad(`ERA checker exited ${status ?? "without a status"}: ${lastErr}`);
  let arr;
  try { arr = JSON.parse(stdout); } catch { return bad("ERA checker exited 10 but printed no JSON"); }
  if (!Array.isArray(arr)) return bad("ERA checker exited 10 but printed no JSON array");
  // The script's seen-state is never advanced here, so a growing group keeps its key: re-key by a decade bucket of the
  // count (1, 10, 100, ...) in the SUBJECT (not the version: it is no app version an accept could wait for) so a tenfold growth alerts again and daily growth does not. The text is stable within a bucket.
  const bucket = (n) => (Number.isFinite(+n) && +n >= 1 ? 10 ** Math.min(4, Math.floor(Math.log10(+n))) : 1);
  const stores = {};
  const findings = arr.filter((e) => e && typeof e === "object" && e.key).map((e) => {
    const b = bucket(e.count);
    stores[`D3.${e.key}.count`] = String(e.count ?? "");
    return finding({ measure: "D3", subject: `ciq:${e.key}#${b}+`, level: "alert", severity: "high", sources: ["era"],
      text: `${e.app} ${e.channel} v${e.version}: ${e.error}, ${b}+ times (top ${e.top}); the count is in the row` });
  });
  return findings.length ? { findings, absent: [], stores } : bad("ERA checker exited 10 but listed no crash group");
}
