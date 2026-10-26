#!/usr/bin/env node
// Exposure watch: what could hurt this repo from outside today — advisories in what it depends on,
// what GitHub is (not) switched on for it, and whether what it publishes is still what it published.
// Model-free: npm, gh, git, public HTTPS APIs. It reads; it never fixes, closes or publishes anything.
//
//   node tools/exposure.mjs run <repoDir> [--name <n>] [--gh <owner/repo>] [--npm <pkg>]
//        [--vscode <publisher.ext> --vscode-manifest <path>] [--release-repo <owner/repo> --apk-cert <sha256>]
//        [--json] [--no-write] [--verbose]
//   node tools/exposure.mjs accept <name> <key> --reason "<text>" [--until-version v | --until-date YYYY-MM-DD | --until-change]
//   node tools/exposure.mjs show <name>              # the newest stored row, no network
//
// Exit: 0 = nothing new · 10 = act (a new open alert, an open install-script or setting-change finding)
// · 2 = a source could not be reached (the reading is unknown, not clean) · 64 = usage / bad input.
// State: <STATE_DIR>/exposure/<name>.jsonl (one row per run, appended), <name>.accepted.json (accepts).
// A reading that does not apply (no --gh, no lockfile) is `absent` with its reason and is printed on
// the first run or with --verbose only. Callers: scripts/release/publish.mjs (the release gate,
// `run … --json` and `accept`). Pure parts: tools/exposure/core.mjs and parse.mjs; I/O: sources.mjs.
// Why: a daily watch beats a release-day surprise, and a check that cannot read must say so, never pass.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { stateDirPick } from "@waterplane/shared";
import {
  a4Findings, applyAccepts, carryForward, exitCode, firstRunOff, installScriptReadings, mergeAdvisories, readLastRow, renderText, settingChanges, untilVersionProblem,
} from "./exposure/core.mjs";
import {
  apkCertFinding, dependabotFindings, eolFindings, ghRepoSettings, licenceFindings, marketplaceFindings, npmAuditFindings,
  npmPublishedFindings, npmVerifyFinding, osvFindings, osvQueries, parseGradleDeps, parsePyproject, parseLockfile,
  parseVersionCatalog, registryFindings, secretScanningFindings, sha256Mismatches,
} from "./exposure/parse.mjs";
import * as src from "./exposure/sources.mjs";

const USAGE = `usage: exposure.mjs run <repoDir> [--name n] [--gh owner/repo] [--npm pkg] [--vscode publisher.ext --vscode-manifest path]
                         [--release-repo owner/repo --apk-cert sha256] [--json] [--no-write] [--verbose]
       exposure.mjs accept <name> <key> --reason "<text>" [--until-version v | --until-date YYYY-MM-DD | --until-change]
       exposure.mjs show <name>`;
const die = (m, code = 64) => { process.stderr.write(`${m}\n`); process.exit(code); };

function parseArgs(argv, valued, flags) {
  const pos = [], o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued.includes(a)) { o[a.slice(2)] = argv[++i]; if (o[a.slice(2)] === undefined) die(`${a} needs a value\n${USAGE}`); }
    else if (flags.includes(a)) o[a.slice(2)] = true;
    else if (a.startsWith("--")) die(`unknown argument ${a}\n${USAGE}`);
    else pos.push(a);
  }
  return { pos, o };
}

const stateDir = () => join(stateDirPick(process.env, homedir()).dir, "exposure");
const rowsFile = (name) => join(stateDir(), `${name}.jsonl`);
const acceptsFile = (name) => join(stateDir(), `${name}.accepted.json`);
const validName = (n) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n ?? "");

function readAccepts(name) {
  if (!existsSync(acceptsFile(name))) return { ok: true, data: null };
  const r = src.readJson(acceptsFile(name));
  return r.ok && r.data && typeof r.data === "object" ? r : { ok: false, why: r.why ?? "not an object" };
}
const absent = (measure, why, unreachable = false) => ({ measure, why, unreachable });

// ---- collectors: each returns { findings, absent, ... } and never throws ---------------------------------

/** A1-A6: every tracked npm lockfile. */
async function collectNpm(dir, files, listed) {
  // complete = every tracked lockfile was read; only then may this run move the A4 baseline
  const out = { findings: [], absent: [], installScripts: new Set(), licences: new Set(), complete: !!listed };
  const locks = files.filter((f) => /(^|\/)(package-lock|npm-shrinkwrap)\.json$/.test(f));
  if (!locks.length) {
    // "no lockfile" is only claimed from a real listing; a failed `git ls-files` is an unreadable source
    out.absent.push(listed ? absent("A1", "no npm lockfile in the repo") : absent("A1", "could not list the tracked files (git ls-files failed), so the lockfiles are unknown", true));
    return out;
  }
  if (!listed) out.absent.push(absent("A1", "could not list the tracked files (git ls-files failed): only the root lockfiles were looked for", true));
  const byName = new Map(); // name -> [{pkg, spec}]
  for (const rel of locks) {
    const lockDir = dirname(join(dir, rel));
    const lj = src.readJson(join(dir, rel));
    // a tracked lockfile that cannot be read DOES apply: the gate must stop on it, and the baseline must not move
    if (!lj.ok) { out.absent.push(absent("A1", `${rel}: ${lj.why}`, true)); out.complete = false; continue; }
    const { packages } = parseLockfile(lj.data);
    const specs = {};
    for (const [p, e] of Object.entries(lj.data.packages ?? {})) {
      if (p !== "" && p.includes("node_modules/")) continue;
      for (const k of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) Object.assign(specs, e?.[k] ?? {});
    }
    for (const p of packages) {
      if (p.hasInstallScript && p.version) out.installScripts.add(`${p.name}@${p.version}`);
      if (p.license) out.licences.add(p.license);
      if (!p.version) continue;
      if (p.workspace) continue; // our own package: not on a registry to be looked up
      if (!byName.has(p.name)) byName.set(p.name, []);
      byName.get(p.name).push({ pkg: p, spec: p.direct ? specs[p.name] : undefined });
    }
    out.findings.push(...licenceFindings(packages.filter((p) => !p.dev)));
    const au = src.npmAudit(lockDir);
    if (!au.ok) { out.absent.push(absent("A1", `npm audit ${rel}: ${au.why}`, au.unreachable)); continue; }
    out.findings.push(...npmAuditFindings(au.data, rel, new Set(packages.filter((p) => p.direct).map((p) => p.name))));
  }
  // registry: one lookup per unique name, 16 at a time; a doc is judged and dropped at once
  const names = [...byName.keys()];
  let failed = 0, unreach = 0, firstWhy = "";
  const res = await src.pool(names, async (name) => {
    const d = await src.registryDoc(name);
    if (!d.ok) return d;
    if (!d.data) return { ok: true, data: [] }; // not on the registry (404): nothing to say
    const f = [];
    for (const { pkg, spec } of byName.get(name)) f.push(...registryFindings(d.data, { name, installed: pkg.version, declared: spec, direct: pkg.direct }));
    return { ok: true, data: f };
  }, 16);
  for (const r of res) {
    if (r.ok) out.findings.push(...r.data);
    else { failed++; if (r.unreachable) unreach++; firstWhy ||= r.why; }
  }
  if (failed) {
    const why = `${failed} of ${names.length} registry lookups failed (${firstWhy})`;
    for (const m of ["A2", "A3"]) out.absent.push(absent(m, why, unreach > 0));
  }
  return out;
}

/** A1 for Gradle / Python manifests, A7 for the node / python support window. */
async function collectOther(dir, files, now) {
  const out = { findings: [], absent: [] };
  const batches = [];
  const gr = files.filter((f) => /(^|\/)build\.gradle(\.kts)?$/.test(f) || /(^|\/)libs\.versions\.toml$/.test(f));
  const maven = new Map(), pypi = new Map();
  for (const rel of gr) {
    const t = src.readText(join(dir, rel));
    if (!t.ok) continue;
    for (const d of rel.endsWith(".toml") ? parseVersionCatalog(t.data) : parseGradleDeps(t.data)) maven.set(`${d.group}:${d.artifact}:${d.version}`, d);
  }
  for (const rel of files.filter((f) => /(^|\/)pyproject\.toml$/.test(f))) {
    const t = src.readText(join(dir, rel));
    if (t.ok) for (const d of parsePyproject(t.data)) pypi.set(`${d.name}:${d.floor}`, d);
  }
  if (maven.size) batches.push(["Maven", [...maven.values()]]);
  if (pypi.size) batches.push(["PyPI", [...pypi.values()]]);
  for (const [eco, deps] of batches) {
    const q = osvQueries(deps, eco);
    if (q.unversioned.length) out.absent.push(absent("A1", `${q.unversioned.length} ${eco} dependencies have no version to look up (${q.unversioned.slice(0, 3).map((d) => d.artifact ?? d.name).join(", ")}…)`));
    if (!q.queried.length) continue;
    const b = await src.osvBatch(q.body);
    if (!b.ok || !b.data) { out.absent.push(absent("A1", `OSV ${eco}: ${b.why ?? "no answer (404)"}`, b.ok ? true : b.unreachable)); continue; }
    const ids = [...new Set((b.data.results ?? []).flatMap((r) => (r.vulns ?? []).map((v) => v.id)))];
    const details = {};
    const got = await src.pool(ids, (id) => src.osvVuln(id), 8);
    ids.forEach((id, i) => { if (got[i].ok && got[i].data) details[id] = got[i].data; });
    // an id whose detail did not arrive is skipped by osvFindings and reported here, never guessed at
    const bad = got.filter((g) => !g.ok || !g.data);
    if (bad.length) out.absent.push(absent("A1", `OSV ${eco}: ${bad.length} advisory lookups failed (${bad[0].why ?? "not found"})`, true));
    out.findings.push(...osvFindings(b.data, q.queried, details));
  }
  // A7: the node / python the repo says it supports
  const eolFor = async (product, minMajor) => {
    const c = await src.eolCycles(product);
    if (!c.ok) return out.absent.push(absent("A7", `endoflife.date ${product}: ${c.why}`, c.unreachable));
    if (!c.data) return out.absent.push(absent("A7", `endoflife.date does not know ${product}`));
    const r = eolFindings(c.data, product, minMajor, now);
    out.findings.push(...r.findings); out.absent.push(...r.absent);
  };
  const rootPkg = files.includes("package.json") ? src.readJson(join(dir, "package.json")) : null;
  const node = /(\d+)/.exec(rootPkg?.ok ? (rootPkg.data.engines?.node ?? "") : "")?.[1];
  if (node) await eolFor("nodejs", node);
  const py = files.includes("pyproject.toml") ? src.readText(join(dir, "pyproject.toml")) : null;
  const pym = py?.ok ? /requires-python\s*=\s*["'][^"']*?(\d+\.\d+)/.exec(py.data)?.[1] : null;
  if (pym) await eolFor("python", pym);
  return out;
}

/** B1-B7 from `gh api`. */
function collectGh(repoSlug, hasManifests, now) {
  const out = { findings: [], absent: [], settings: {} };
  const gone = (why, unreachable) => { for (const m of ["B1", "B2", "B3", "B4", "B5", "B6"]) out.absent.push(absent(m, why, unreachable)); };
  const repo = src.ghApi(`repos/${repoSlug}`);
  if (!repo.ok) { gone(`gh api repos/${repoSlug}: ${repo.why}`, repo.unreachable); return out; }
  if (!repo.data) { gone(`repo ${repoSlug} not found or not visible to this token`, false); return out; }
  const perms = src.ghApi(`repos/${repoSlug}/actions/permissions/workflow`);
  const branch = repo.data.default_branch ?? "main";
  const prot = src.ghApi(`repos/${repoSlug}/branches/${encodeURIComponent(branch)}/protection`);
  const rules = src.ghApi(`repos/${repoSlug}/rulesets`);
  const owner = repo.data.owner;
  const org = owner?.type === "Organization" ? src.ghApi(`orgs/${owner.login}`) : null;
  const dep = src.ghApi(`repos/${repoSlug}/contents/.github/dependabot.yml`);
  const dep2 = dep.ok && !dep.data ? src.ghApi(`repos/${repoSlug}/contents/.github/dependabot.yaml`) : dep;
  const g = ghRepoSettings({
    repo: repo.data,
    workflowPerms: perms.ok ? perms.data : undefined,
    protection: prot.ok ? prot.data : undefined, // 404 -> null -> none
    rulesets: rules.ok ? rules.data : undefined,
    org: org?.ok ? org.data : undefined,
    dependabotConfigPresent: dep2.ok ? !!dep2.data : true, // unreadable: do not claim it is missing
    hasManifests,
  });
  out.settings = g.settings; out.findings.push(...g.findings); out.absent.push(...g.absent);
  // name each failed read by its own cause (a timeout is not a missing token right)
  const failed = { B5: perms, B4: !prot.ok ? prot : rules, B6: org };
  for (const a of out.absent) {
    const r = failed[a.measure];
    if (r && !r.ok) { a.why = `gh api: ${r.why}`; a.unreachable = !!r.unreachable; }
  }
  const al = src.ghApi(`repos/${repoSlug}/dependabot/alerts?state=open&per_page=100`);
  if (al.ok) out.findings.push(...dependabotFindings(al.data ?? [], now));
  else out.absent.push(absent("B1", `Dependabot alerts: ${al.why}`, al.unreachable));
  if (/^scanning on/.test(out.settings.B2 ?? "")) {
    const ss = src.ghApi(`repos/${repoSlug}/secret-scanning/alerts?state=open&per_page=100`);
    if (ss.ok) out.findings.push(...secretScanningFindings(ss.data ?? []));
    else out.absent.push(absent("B2", `secret-scanning alerts: ${ss.why}`, ss.unreachable));
  }
  return out;
}

/** C1: what is on npm. */
function collectNpmPublished(pkg) {
  const out = { findings: [], absent: [], readings: {} };
  const v = src.npmView(pkg);
  if (!v.ok) { out.absent.push(absent("C1", v.why, v.unreachable)); return out; }
  const p = npmPublishedFindings(v.data);
  out.findings.push(...p.findings);
  out.readings = { "C1.maintainers": JSON.stringify(p.readings.maintainers), "C1.distTags": JSON.stringify(Object.fromEntries(Object.entries(p.readings.distTags).sort())) };
  const latest = p.readings.distTags.latest ?? v.data.version;
  if (!latest) { out.absent.push(absent("C1", `${pkg} has no latest version`)); return out; }
  const ver = src.npmVerify(pkg, latest);
  if (!ver.ok) out.absent.push(absent("C1", ver.why, true));
  else if (ver.data.status === 1) out.findings.push(npmVerifyFinding(pkg, latest, ver.data.stdout));
  else if (ver.data.status !== 0) out.absent.push(absent("C1", `npm-verify exited ${ver.data.status}: ${ver.data.stdout.trim().slice(-160)}`, true));
  return out;
}

/** C2: the latest GitHub release's .sha256 files and, with an expected cert, the APK's signer. */
function collectRelease(repo, apkCert) {
  const out = { findings: [], absent: [] };
  const rel = src.ghLatestRelease(repo);
  if (!rel.ok) { out.absent.push(absent("C2", rel.why, rel.unreachable)); return out; }
  const names = (rel.data.assets ?? []).map((a) => a.name);
  const sums = names.filter((n) => n.endsWith(".sha256"));
  const apk = names.find((n) => n.endsWith(".apk"));
  const want = new Set(sums.flatMap((n) => [n, n.slice(0, -7)]).filter((n) => names.includes(n)));
  if (apkCert && apk) want.add(apk);
  if (!want.size) { out.absent.push(absent("C2", `release ${rel.data.tagName} has no .sha256 assets`)); return out; }
  let tmp = null;
  try {
    tmp = mkdtempSync(join(tmpdir(), "exposure-"));
    const d = src.ghDownload(repo, rel.data.tagName, [...want], tmp);
    if (!d.ok) { out.absent.push(absent("C2", d.why, d.unreachable)); return out; }
    out.findings.push(...sha256Mismatches(d.data));
    if (apkCert) {
      const signer = src.findApksigner();
      if (!apk) out.absent.push(absent("C2", "no APK among the release assets to check the signing certificate of"));
      else if (!signer) out.absent.push(absent("C2", "apksigner not found (ANDROID_HOME / build-tools)"));
      else {
        const c = src.apksignerCerts(signer, join(tmp, apk));
        if (!c.ok) out.absent.push(absent("C2", c.why));
        else { const a = apkCertFinding(c.data, apkCert); out.findings.push(...a.findings); out.absent.push(...a.absent); }
      }
    }
  } catch (e) { out.absent.push(absent("C2", `could not prepare a scratch directory: ${e.message}`)); }
  finally { if (tmp) rmSync(tmp, { recursive: true, force: true }); }
  return out;
}

/** C3: the Marketplace listing against the local manifest. */
async function collectMarketplace(dir, extId, manifest, now) {
  const out = { findings: [], absent: [] };
  const m = src.readJson(resolve(dir, manifest));
  if (!m.ok || !m.data.version) { out.absent.push(absent("C3", `cannot read the version from ${manifest}`)); return out; }
  const q = await src.marketplaceQuery(extId);
  if (!q.ok) { out.absent.push(absent("C3", q.why, q.unreachable)); return out; }
  const when = src.gitVersionDate(dir, manifest, m.data.version);
  out.findings.push(...marketplaceFindings(q.data, { localVersion: m.data.version, localVersionDate: when.ok ? when.data : undefined, now, name: extId }));
  return out;
}

// ---- commands ------------------------------------------------------------------------------------------

async function cmdRun(argv) {
  const { pos, o } = parseArgs(argv, ["--name", "--gh", "--npm", "--vscode", "--vscode-manifest", "--release-repo", "--apk-cert"], ["--json", "--no-write", "--verbose"]);
  if (pos.length !== 1) die(USAGE);
  const dir = resolve(pos[0]);
  if (!existsSync(dir)) die(`no such directory: ${dir}`);
  const name = o.name ?? basename(dir);
  if (!validName(name)) die(`bad --name ${name}`);
  if (o.vscode && !o["vscode-manifest"]) die("--vscode needs --vscode-manifest <path>");
  if (o["apk-cert"] && !o["release-repo"]) die("--apk-cert needs --release-repo");
  const nowD = new Date(), now = nowD.toISOString();

  const prevText = existsSync(rowsFile(name)) ? src.readText(rowsFile(name)) : null;
  const prev = prevText?.ok ? readLastRow(prevText.data) : null;
  const acc = readAccepts(name);
  if (!acc.ok) die(`${acceptsFile(name)} is unreadable (${acc.why}); fix or remove it`, 2); // before any network work
  const gitList = src.gitFiles(dir), listed = gitList.ok;
  const files = (() => {
    if (listed) return gitList.data;
    return ["package-lock.json", "npm-shrinkwrap.json", "package.json", "pyproject.toml"].filter((f) => existsSync(join(dir, f)));
  })();

  const parts = [];
  const npm = await collectNpm(dir, files, listed);
  parts.push(npm, await collectOther(dir, files, nowD));
  const hasManifests = files.some((f) => /(^|\/)(package\.json|build\.gradle(\.kts)?|pyproject\.toml)$/.test(f));
  let settings = {};
  if (o.gh) { const g = collectGh(o.gh, hasManifests, nowD); parts.push(g); settings = { ...g.settings }; }
  else parts.push({ findings: [], absent: ["B1", "B2", "B3", "B4", "B5", "B6", "B7"].map((m) => absent(m, "no --gh given")) });
  if (o.npm) { const c = collectNpmPublished(o.npm); parts.push(c); Object.assign(settings, c.readings); }
  if (o.vscode) parts.push(await collectMarketplace(dir, o.vscode, o["vscode-manifest"], nowD));
  if (o["release-repo"]) parts.push(collectRelease(o["release-repo"], o["apk-cert"]));

  const installScripts = [...npm.installScripts].sort();
  const prevReadings = prev?.readings ?? null;
  const stored = installScriptReadings(prevReadings, installScripts, npm.complete);
  if (!npm.complete) npm.absent.push(absent("A4", "a tracked lockfile was unreadable: the install-script baseline is kept from the last complete run"));
  const readings = { ...(stored ? { installScripts: stored } : {}), settings, licences: [...npm.licences].sort() };
  let findings = parts.flatMap((p) => p.findings);
  findings.push(...a4Findings(prevReadings, npm.complete ? installScripts : []), ...settingChanges(prevReadings?.settings ?? null, settings));
  findings = carryForward(prev, mergeAdvisories(findings), readings, now);
  findings = applyAccepts(findings, acc.data, nowD);
  const head = src.gitHead(dir);
  const row = { v: 1, at: now, repo: name, dir, ...(head ? { head } : {}), findings, absent: parts.flatMap((p) => p.absent ?? []), readings, ...(prev ? {} : { firstRun: true }) };
  const code = exitCode(row, prev);

  if (!o["no-write"]) {
    try { mkdirSync(stateDir(), { recursive: true }); appendFileSync(rowsFile(name), `${JSON.stringify(row)}\n`); }
    catch (e) { process.stderr.write(`could not store the row: ${e.message}\n`); }
  }
  // exitCode, not process.exit: a pipe write past the kernel buffer is async and exit would cut the row
  if (o.json) process.stdout.write(`${JSON.stringify(row)}\n`);
  else print(row, prev, o.verbose);
  process.exitCode = code;
}

/** Text output: absent-because-it-does-not-apply is shown on a first run or with --verbose only. */
function print(row, prev, verbose) {
  const shown = verbose || row.firstRun ? row : { ...row, absent: (row.absent ?? []).filter((a) => a.unreachable) };
  const open = row.findings.filter((f) => !f.accepted);
  process.stdout.write(`exposure ${row.repo}${row.head ? ` @ ${row.head}` : ""}: ${open.filter((f) => f.level === "alert").length} open alerts, ${open.filter((f) => f.level === "digest").length} digest, ${row.findings.length - open.length} accepted\n`);
  // a long list of findings (a stale manifest can carry sixty advisories) is cut at CAP; --verbose shows all
  const CAP = 15;
  let n = 0, hidden = 0;
  for (const l of renderText(shown, prev)) {
    if (/^(NEW|OPEN) /.test(l) && !verbose && ++n > CAP) { hidden++; continue; }
    process.stdout.write(`${l}\n`);
  }
  if (hidden) process.stdout.write(`… and ${hidden} more open alerts (--verbose, or \`show\` with the stored row)\n`);
  if (row.firstRun) {
    // the open alerts were just printed above; this block adds only what is off or unreadable
    const again = new Set(open.filter((f) => f.level === "alert").map((f) => `${f.measure} ${f.subject}: ${f.text}`));
    process.stdout.write("first run — off today:\n");
    for (const l of firstRunOff(row)) if (!again.has(l)) process.stdout.write(`  ${l}\n`);
  }
}

function cmdAccept(argv) {
  const { pos, o } = parseArgs(argv, ["--reason", "--until-version", "--until-date"], ["--until-change"]);
  if (pos.length !== 2 || !o.reason?.trim()) die(USAGE);
  const [name, key] = pos;
  if (!validName(name)) die(`bad name ${name}`);
  const untils = ["until-version", "until-date", "until-change"].filter((k) => o[k]);
  if (untils.length > 1) die("give at most one --until-*");
  if (o["until-date"] && Number.isNaN(Date.parse(o["until-date"]))) die(`bad --until-date ${o["until-date"]}`);
  const last = existsSync(rowsFile(name)) ? readLastRow(src.readText(rowsFile(name)).data ?? "") : null;
  const f = last?.findings?.find((x) => x.key === key);
  if (!f) process.stderr.write(`note: ${key} is not in ${name}'s newest row; recorded anyway\n`);
  const bad = untilVersionProblem(o["until-version"], f);
  if (bad) die(bad);
  const entry = { reason: o.reason.trim(), at: new Date().toISOString() };
  if (o["until-version"]) entry.until = { version: o["until-version"] };
  if (o["until-date"]) entry.until = { date: o["until-date"] };
  if (o["until-change"]) {
    if (!f) die("--until-change needs the finding in the newest row (it records the finding's text)");
    entry.until = { change: f.text };
  }
  const cur = readAccepts(name);
  if (!cur.ok) die(`${acceptsFile(name)} is unreadable (${cur.why}); not overwriting it`, 2);
  const next = { ...(cur.data ?? {}), [key]: entry };
  mkdirSync(stateDir(), { recursive: true });
  const tmp = `${acceptsFile(name)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, acceptsFile(name));
  process.stdout.write(`accepted ${key} for ${name}: ${entry.reason}\n`);
}

function cmdShow(argv) {
  const { pos } = parseArgs(argv, [], []);
  if (pos.length !== 1 || !validName(pos[0])) die(USAGE);
  const t = existsSync(rowsFile(pos[0])) ? src.readText(rowsFile(pos[0])) : null;
  if (!t?.ok) die(`no stored row for ${pos[0]} (${rowsFile(pos[0])})`);
  const lines = t.data.split("\n").filter(Boolean);
  const row = readLastRow(t.data);
  if (!row) die(`no readable row for ${pos[0]}`);
  const i = lines.lastIndexOf(lines.find((l) => { try { return JSON.parse(l).at === row.at; } catch { return false; } }));
  const prev = i > 0 ? readLastRow(lines.slice(0, i).join("\n")) : null;
  print(row, prev, false);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "run") await cmdRun(rest);
else if (cmd === "accept") cmdAccept(rest);
else if (cmd === "show") cmdShow(rest);
else die(USAGE);

