// Pure parts of the exposure watch (`tools/exposure.mjs`): the finding model, how findings from
// different sources collapse into one, what carries over from the last run, what a person has
// accepted, and what an exit code or a release gate makes of the result. No process, no network, no
// file reads: the CLI gathers the payloads (parse.mjs turns them into findings) and everything here
// is decided from values, so it is tested in isolation (tools/exposure-core.test.mjs). Why it looks
// like this: a daily, model-free read of what could hurt the repo from outside beats a release-day
// surprise; a source it could not read is `absent` (never a pass), and a person's accept lives in a
// file beside the stored rows, never inside a finding.

/** @typedef {"critical"|"high"|"moderate"|"low"|"info"} Severity */
/** @typedef {{version?:string}|{date?:string}|{change?:string}} Until  until a newer version / a date / the reading changes (change = the finding's text at accept time) */
/**
 * @typedef {{
 *   key: string, measure: string, subject: string, version?: string, level: "alert"|"digest",
 *   severity?: Severity, direct?: boolean, text: string, sources: string[], advisory?: string,
 *   since?: string, accepted?: {reason:string, at:string, until?:Until}
 * }} Finding
 */
/** @typedef {{measure:string, why:string, unreachable:boolean}} Absent  never a pass, never a zero */
/**
 * @typedef {{
 *   v: 1, at: string, repo: string, dir: string, head?: string, findings: Finding[], absent: Absent[],
 *   readings: {installScripts?: string[], settings?: Record<string,string>, licences?: string[]},
 *   firstRun?: true
 * }} Row
 */

const SEVERITY_ORDER = ["info", "low", "moderate", "high", "critical"];
const sevRank = (s) => SEVERITY_ORDER.indexOf(s);
const SETTING_SOURCE = "setting change";

/** Built-in accepts, merged UNDER the accepts file's (the file wins). Keys are what parse.mjs emits. */
export const PRE_ACCEPTED = {
  "A2:node-pty": { reason: "node-pty is pinned to a pre-release on purpose (SECURITY.md)", at: "2026-10-26" },
  "A5:web-push": { reason: "MPL-2.0, accepted on purpose", at: "2026-10-26" },
};

/** Semver-ish compare (-1/0/1); a pre-release sorts below its release, `v` and `+build` ignored. */
export function semverCmp(a, b) {
  const split = (s) => {
    const [core, ...rest] = String(s).trim().replace(/^v/, "").split("+")[0].split("-");
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

/** The dedupe + accept key. An advisory id makes A1 and B1 for one package ONE key (one Accept). */
export function findingKey({ measure, subject, version, advisory }) {
  if (advisory) return `adv:${advisory}:${subject}`;
  return `${measure}:${subject}${version ? `@${version}` : ""}`;
}

/** Same key => one finding: sources unioned, max severity, direct OR'd, alert wins, first measure kept. */
export function mergeAdvisories(findings) {
  const by = new Map();
  for (const f of findings) {
    const prev = by.get(f.key);
    if (!prev) { by.set(f.key, { ...f, sources: [...(f.sources ?? [])] }); continue; }
    prev.sources = [...new Set([...prev.sources, ...(f.sources ?? [])])];
    if (sevRank(f.severity) > sevRank(prev.severity)) prev.severity = f.severity;
    if (f.direct || prev.direct) prev.direct = true;
    if (f.level === "alert") prev.level = "alert";
  }
  return [...by.values()];
}

const nameOf = (nv) => { const i = String(nv).lastIndexOf("@"); return i > 0 ? nv.slice(0, i) : String(nv); };

/**
 * Fill `since` from the previous row's same key (else `now`), and re-add the previous run's A4
 * findings whose package still has an install script: A4 persists until accepted, because the
 * baseline in readings moves on every run and would otherwise let it vanish after one day.
 */
export function carryForward(prevRow, findings, readings, now) {
  const prevBy = new Map((prevRow?.findings ?? []).map((f) => [f.key, f]));
  const out = findings.map((f) => ({ ...f, since: prevBy.get(f.key)?.since ?? f.since ?? now }));
  const have = new Set(out.map((f) => f.key));
  const still = new Set((readings?.installScripts ?? []).map(nameOf));
  for (const f of prevRow?.findings ?? []) {
    if (f.measure !== "A4" || have.has(f.key) || !still.has(f.subject)) continue;
    const { accepted: _a, ...rest } = f; // the accepts file decides again in applyAccepts
    out.push({ ...rest, since: f.since ?? now });
  }
  return out;
}

/**
 * The install-script baseline to STORE. A run that could not read every tracked lockfile must not move
 * it (the next run would call every package of the missing lockfile "new"): it carries the last
 * complete baseline, or none (a first run that is incomplete has no baseline yet).
 */
export function installScriptReadings(prevReadings, current, complete) {
  if (complete) return current;
  return Array.isArray(prevReadings?.installScripts) ? prevReadings.installScripts : undefined;
}

/** Why `accept --until-version` cannot work here, or null: it needs a finding that carries a version. */
export function untilVersionProblem(untilVersion, f) {
  if (!untilVersion) return null;
  if (!f) return "--until-version needs the finding in the newest row (it compares against the finding's version)";
  if (!f.version) return `${f.key} has no version to compare, so --until-version would never expire: use --until-change or --until-date`;
  return null;
}

/** A4: names with an install script now that had none in the previous readings; no baseline => []. */
export function a4Findings(prevReadings, currentInstallScripts) {
  if (!prevReadings || !Array.isArray(prevReadings.installScripts)) return [];
  const had = new Set(prevReadings.installScripts.map(nameOf));
  const seen = new Set();
  const out = [];
  for (const nv of currentInstallScripts ?? []) {
    const name = nameOf(nv);
    if (had.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({
      key: findingKey({ measure: "A4", subject: name }), measure: "A4", subject: name,
      version: nv.slice(name.length + 1) || undefined, level: "alert", sources: ["lockfile"],
      text: `${name} now has an install script (it runs code on npm install).`,
    });
  }
  return out;
}

/** B2-B6 (and C1.*) alert findings for every value that changed since the last run; no baseline => []. */
export function settingChanges(prevSettings, settings) {
  if (!prevSettings) return [];
  const out = [];
  for (const [name, now] of Object.entries(settings ?? {})) {
    if (!(name in prevSettings) || prevSettings[name] === now) continue;
    const measure = name.split(".")[0];
    out.push({
      key: findingKey({ measure, subject: name }), measure, subject: name, level: "alert",
      sources: [SETTING_SOURCE], text: `${name}: ${prevSettings[name]} → ${now}`,
    });
  }
  return out;
}

/** The first run's "what is off today" block: B settings off/none/write, absent measures, alerts. */
export function firstRunOff(row) {
  const lines = [];
  for (const [name, v] of Object.entries(row.readings?.settings ?? {})) {
    if (/(^|[\s,])off$|(^|[\s,])off,|^(none|write)$/.test(v)) lines.push(`${name}: ${v}`);
  }
  for (const a of row.absent ?? []) lines.push(`${a.measure}: absent — ${a.why}`);
  for (const f of row.findings ?? []) if (f.level === "alert" && !f.accepted) lines.push(`${f.measure} ${f.subject}: ${f.text}`);
  return lines;
}

const toMs = (d) => (d instanceof Date ? d.getTime() : Date.parse(d));

/** Is this accept still live for this finding? Every condition it names must hold; none => forever. */
function acceptLive(f, a, now) {
  const u = a.until;
  if (!u) return true;
  if (u.version !== undefined && f.version && semverCmp(f.version, u.version) > 0) return false;
  if (u.date !== undefined && !(toMs(u.date) > toMs(now))) return false;
  if (u.change !== undefined && u.change !== f.text) return false;
  return true;
}

/** Set `accepted` on every finding with a live accept; PRE_ACCEPTED sits under the file's (file wins). */
export function applyAccepts(findings, accepts, now) {
  const all = { ...PRE_ACCEPTED, ...(accepts ?? {}) };
  return findings.map((f) => {
    const a = all[f.key];
    if (!a || !acceptLive(f, a, now)) { const { accepted: _x, ...rest } = f; return rest; }
    return { ...f, accepted: { reason: a.reason, at: a.at, ...(a.until ? { until: a.until } : {}) } };
  });
}

/** A key absent from the previous row's findings (no previous row => everything is new). */
export const isNew = (f, prevRow) => !(prevRow?.findings ?? []).some((p) => p.key === f.key);

/** 10 = act (a new open alert, any open A4 or setting change), 2 = a source unreachable, else 0. */
export function exitCode(row, prevRow) {
  const open = (row.findings ?? []).filter((f) => !f.accepted && f.level === "alert");
  if (open.some((f) => isNew(f, prevRow) || f.measure === "A4" || (f.sources ?? []).includes(SETTING_SOURCE))) return 10;
  if ((row.absent ?? []).some((a) => a.unreachable)) return 2;
  return 0;
}

/** What stops a release (open A1 high/critical, A4, C1 alert, an unreadable A1/C1) and what only prints. */
export function gateVerdict(row) {
  const open = (row.findings ?? []).filter((f) => !f.accepted);
  const stop = (f) => (f.measure === "A1" && (f.severity === "high" || f.severity === "critical")) || f.measure === "A4" || (f.measure === "C1" && f.level === "alert");
  const stops = open.filter(stop);
  for (const a of row.absent ?? []) {
    if (!a.unreachable || (a.measure !== "A1" && a.measure !== "C1")) continue;
    stops.push({
      key: `${a.measure}:unreachable`, measure: a.measure, subject: a.measure, level: "alert", sources: [], synthetic: true,
      text: `could not read ${a.measure}: ${a.why}`,
    });
  }
  return { stops, prints: open.filter((f) => !stop(f)) };
}

const lockEntries = (lock) => {
  const by = new Map(); // name -> Map(version -> hasInstallScript)
  for (const [path, p] of Object.entries(lock?.packages ?? {})) {
    if (!path || !p?.version) continue;
    const name = p.name && !path.includes("node_modules/") ? p.name : path.slice(path.lastIndexOf("node_modules/") + 13);
    if (!by.has(name)) by.set(name, new Map());
    by.get(name).set(p.version, !!p.hasInstallScript);
  }
  return by;
};

/** Lockfile v3 diff keyed by package NAME: added, removed, and names that gained an install script. */
export function depDiff(oldLock, newLock) {
  const a = lockEntries(oldLock), b = lockEntries(newLock);
  const fmt = (name, m) => [...m.keys()].sort(semverCmp).map((v) => `${name}@${v}`);
  const added = [], removed = [], gainedInstallScript = [];
  for (const [name, m] of b) {
    if (!a.has(name)) added.push(...fmt(name, m));
    const had = [...(a.get(name)?.values() ?? [])].some(Boolean);
    if (!had) gainedInstallScript.push(...[...m].filter(([, s]) => s).map(([v]) => `${name}@${v}`));
  }
  for (const [name, m] of a) if (!b.has(name)) removed.push(...fmt(name, m));
  return { added: added.sort(), removed: removed.sort(), gainedInstallScript: gainedInstallScript.sort() };
}

/** Lines for stdout: new alerts, other open alerts, accepted with reasons, digest counts, absent. */
export function renderText(row, prevRow) {
  const fs = row.findings ?? [];
  const line = (f) => `${f.measure} ${f.subject}${f.version ? `@${f.version}` : ""}: ${f.text}  [${f.key}]`;
  const openAlerts = fs.filter((f) => f.level === "alert" && !f.accepted);
  const lines = [];
  const fresh = openAlerts.filter((f) => isNew(f, prevRow));
  for (const f of fresh) lines.push(`NEW ${line(f)}`);
  for (const f of openAlerts) if (!fresh.includes(f)) lines.push(`OPEN ${line(f)}`);
  const accepted = fs.filter((f) => f.accepted);
  if (accepted.length) {
    lines.push(`accepted (${accepted.length}):`);
    for (const f of accepted) lines.push(`  ${f.measure} ${f.subject}: ${f.accepted.reason}`);
  }
  const digest = fs.filter((f) => f.level === "digest" && !f.accepted);
  if (digest.length) {
    const n = {};
    for (const f of digest) n[f.measure] = (n[f.measure] ?? 0) + 1;
    lines.push(`digest: ${Object.entries(n).sort().map(([m, c]) => `${m} ${c}`).join(", ")}`);
  }
  for (const a of row.absent ?? []) lines.push(`absent ${a.measure}${a.unreachable ? " (unreachable)" : ""}: ${a.why}`);
  if (!lines.length) lines.push("nothing open");
  return lines;
}

/** The last parseable JSON line of a JSONL string; a torn last line (a crash mid-append) is skipped. */
export function readLastRow(text) {
  const lines = String(text ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    try {
      const v = JSON.parse(lines[i]);
      if (v && typeof v === "object") return v;
    } catch { /* torn line: try the one before */ }
  }
  return null;
}
