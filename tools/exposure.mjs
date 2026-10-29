#!/usr/bin/env node
// Exposure watch: what could hurt this repo from outside today — advisories in what it depends on,
// what GitHub is (not) switched on for it, and whether what it publishes is still what it published.
// Model-free: npm, gh, git, public HTTPS APIs. It reads; it never fixes, closes or publishes anything.
//
//   node tools/exposure.mjs run <repoDir> [--name <n>] [--gh <owner/repo>] [--npm <pkg>]
//        [--vscode <publisher.ext> --vscode-manifest <path>] [--release-repo <owner/repo> --apk-cert <sha256>]
//        [--privacy-url <url>]... [--domain <name>] [--npm-2fa-confirmed YYYY-MM-DD]
//        [--play <package> [--play-key-missing <why>]] [--era-check <script>] [--only <A,B,C,D|ids>]
//        [--json] [--no-write] [--verbose]
//   node tools/exposure.mjs run --target <name> [more flags]   # dir/gh/args from <STATE_DIR>/exposure/targets.json
//   node tools/exposure.mjs targets                  # one `name<TAB>play(0|1)` line per valid target; exit 2 when there are none
//   node tools/exposure.mjs scorecard --target <name> # a PRIVATE gh repo scored locally by the scorecard CLI -> <STATE_DIR>/scorecard/local/
//   node tools/exposure.mjs accept <name> <key> --reason "<text>" [--until-version v | --until-date YYYY-MM-DD | --until-change]
//   node tools/exposure.mjs show <name>              # the newest stored row, no network
//   node tools/exposure.mjs era-seen --target <name> # the person handled ERA's crash groups: --mark-seen, then read again
//
// C5 privacy URLs answer 200, C6 domain expiry, C7 npm 2FA confirmed by hand (dated), D1 Play targetSdk vs the
// required API, D2 Play vitals (tools/exposure/play.mjs), D3 Connect IQ ERA (<script> --json: 0 nothing new / 10 act /
// 2 cannot reach). Their readings go to row.readings.stores, never into the B settings diff. --only runs just those
// measures (a store-only row for a private repo): a letter enables its whole group, an id only that measure; the
// stores of measures not run are carried from the last row. A --only row MUST use its own --name: findings are
// compared with the last row, so a full run after an --only row of the same name sees everything as new.
// Env: EXPOSURE_PLAY_KEY_FILE = path to the Play service-account JSON (the only way D2 gets a key).
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
  apkCertFinding, dependabotFindings, eolFindings, eraFindings, manualConfirmFinding, privacyUrlFinding, rdapExpiryFinding, targetApiFinding, targetSdkFiles, targetSdkReadings, ghRepoSettings, licenceFindings, marketplaceFindings, npmAuditFindings,
  npmPublishedFindings, npmVerifyFinding, osvFindings, osvQueries, parseGradleDeps, parsePyproject, parseLockfile,
  parseVersionCatalog, registryFindings, secretScanningFindings, sha256Mismatches,
} from "./exposure/parse.mjs";
import * as src from "./exposure/sources.mjs";
import { collectPlayVitals } from "./exposure/play.mjs";
import { parseTargets, targetRunArgv, unsetTargetVars, unsetVarsSentence } from "./exposure/targets.mjs";

const USAGE = `usage: exposure.mjs run --target <name> [flags] | targets | scorecard --target <name>
       exposure.mjs run <repoDir> [--name n] [--gh owner/repo] [--npm pkg] [--vscode publisher.ext --vscode-manifest path]
                         [--release-repo owner/repo --apk-cert sha256]
                         [--privacy-url url]... [--domain name] [--npm-2fa-confirmed YYYY-MM-DD] [--play package] [--play-key-missing why]
                         [--era-check script] [--only A,B,C,D|ids] [--json] [--no-write] [--verbose]
       exposure.mjs accept <name> <key> --reason "<text>" [--until-version v | --until-date YYYY-MM-DD | --until-change]
       exposure.mjs show <name>
       exposure.mjs era-seen --target <name>`;
const die = (m, code = 64) => { process.stderr.write(`${m}\n`); process.exit(code); };

function parseArgs(argv, valued, flags, repeat = []) {
  const pos = [], o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (repeat.includes(a)) { if (argv[i + 1] === undefined) die(`${a} needs a value\n${USAGE}`); (o[a.slice(2)] ??= []).push(argv[++i]); }
    else if (valued.includes(a)) { o[a.slice(2)] = argv[++i]; if (o[a.slice(2)] === undefined) die(`${a} needs a value\n${USAGE}`); }
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
async function collectGh(repoSlug, hasManifests, now) {
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
  // gh blind to both: ask Scorecard (public API, no credential) - only for a repo GitHub itself says is public
  let sc;
  if (!prot.ok && !rules.ok && repo.data.private === false) {
    const r = await src.scorecardBranch(repoSlug);
    if (r.ok) sc = r.data; // null = not scored; a failed call stays undefined (plain "not readable")
  }
  const g = ghRepoSettings({
    repo: repo.data,
    scorecardBranch: sc,
    workflowPerms: perms.ok ? perms.data : undefined,
    protection: prot.ok ? prot.data : undefined, // 404 -> null -> none
    rulesets: rules.ok ? rules.data : undefined,
    org: org?.ok ? org.data : undefined,
    dependabotConfigPresent: dep2.ok ? !!dep2.data : true, // unreadable: do not claim it is missing
    hasManifests,
  });
  out.settings = g.settings; out.notes = g.notes; out.findings.push(...g.findings); out.absent.push(...g.absent);
  // name each failed read by its own cause (a timeout is not a missing token right)
  const failed = { B5: perms, B4: !prot.ok ? prot : rules, B6: org };
  for (const a of out.absent) {
    const r = failed[a.measure];
    if (r && !r.ok) { a.why = `gh api: ${r.why}${/Scorecard/.test(a.why) ? "; Scorecard's Branch-Protection check is inconclusive or not scored" : ""}`; a.unreachable = !!r.unreachable; }
  }
  // A private repo on GitHub's free plan has no branch rules to read or set: say THAT, not a raw 403.
  const plan = (r) => !r.ok && /Upgrade to GitHub Pro/i.test(String(r.why ?? ""));
  if (repo.data.private === true && plan(prot) && plan(rules)) {
    for (const a of out.absent) if (a.measure === "B4") a.why = "a private repo on GitHub's free plan cannot have branch rules (GitHub Pro, or making the repo public, would allow them)";
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

/** C5: each privacy-policy URL answers 200 after redirects. */
async function collectPrivacy(urls) {
  const out = { findings: [], absent: [] };
  for (const u of urls) { const r = privacyUrlFinding(u, await src.httpStatus(u)); out.findings.push(...r.findings); out.absent.push(...r.absent); }
  return out;
}

/** C6: when the domain expires, from RDAP. */
async function collectDomain(domain, now) {
  const out = { findings: [], absent: [], stores: {} };
  const r = await src.rdapDomain(domain);
  if (!r.ok) { out.absent.push(absent("C6", `RDAP ${domain}: ${r.why}`, r.unreachable)); return out; }
  if (!r.data) { out.absent.push(absent("C6", `RDAP has no record of ${domain}`)); return out; }
  const f = rdapExpiryFinding(r.data, domain, now);
  out.findings.push(...f.findings); out.absent.push(...f.absent);
  if (f.reading) out.stores[`C6.${domain}`] = f.reading;
  return out;
}

/** D1: the targetSdk literal(s) in the tracked build files against Play's required API. */
function collectTargetApi(dir, files, pkg, now) {
  const out = { findings: [], absent: [], stores: {} };
  const want = targetSdkFiles(files);
  const texts = want.map((path) => ({ path, text: src.readText(join(dir, path)).data ?? "" }));
  const t = targetSdkReadings(texts);
  if (!t) { out.absent.push(absent("D1", "no targetSdk literal in the build files")); return out; }
  out.findings.push(...targetApiFinding(t.value, t.file, now, pkg));
  out.stores[`D1.${pkg}`] = `${t.value} (${t.file})`;
  return out;
}

/** D3: the Connect IQ ERA checker (read-only: never --mark-seen). */
function collectEra(script) {
  // the script allows itself ~900 s (its fetch may fall back to a headless browser): kill later than that, with margin
  const r = src.run("python3", [script, "--json"], { timeout: 960_000 });
  if (!r.ok) return { findings: [], absent: [absent("D3", r.why, true)] };
  return eraFindings(r.data.status, r.data.stdout, r.data.stderr);
}

/** --only "C,D" / "D3": which measure letters or ids are wanted; undefined = all. */
function onlyFilter(list) {
  if (list === undefined) return { want: () => true, wantL: () => true, list: undefined };
  const w = String(list).split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
  if (!w.length || w.some((x) => !/^[A-D]\d?$/.test(x))) die(`bad --only ${list} (letters A-D or ids like D3)`);
  return { want: (m) => w.some((x) => x === m || x === m[0]), wantL: (L) => w.some((x) => x[0] === L), list: w };
}

// ---- commands ------------------------------------------------------------------------------------------

const targetsFile = () => join(stateDir(), "targets.json");

/** The valid targets from targets.json; a missing or unreadable file is no targets. Problems go to stderr. */
function loadTargets() {
  if (!existsSync(targetsFile())) return [];
  const r = src.readJson(targetsFile());
  if (!r.ok) { process.stderr.write(`${targetsFile()} is unreadable (${r.why})\n`); return []; }
  const { targets, problems } = parseTargets(r.data);
  for (const p of problems) process.stderr.write(`targets.json: ${p}\n`);
  return targets;
}

/** `--target <name>` (anywhere in argv) -> the target, or exits. Returns the target and the remaining argv. */
function pickTarget(argv) {
  const i = argv.indexOf("--target");
  if (i < 0 || !argv[i + 1]) die(`--target needs a name\n${USAGE}`);
  const name = argv[i + 1];
  const t = loadTargets().find((x) => x.name === name);
  if (!t) die(`no valid target named ${name} in ${targetsFile()}`, 2);
  return { t, rest: argv.filter((_, j) => j !== i && j !== i + 1) };
}

function cmdTargets() {
  const ts = loadTargets();
  if (!ts.length) die(`no exposure targets in ${targetsFile()} (add one on the phone, or write the file: {"version":1,"targets":[{"name","dir","gh"}]})`, 2);
  for (const t of ts) process.stdout.write(`${t.name}\t${t.play ? 1 : 0}\n`);
}

/** The CLI's JSON reply: the one stdout line that is a JSON object (it may print a "Skipping …" line too). */
function jsonLine(stdout) {
  return String(stdout).split("\n").map((l) => l.trim()).find((l) => l.startsWith("{") && l.endsWith("}")) ?? null;
}

/** A private GitHub repo target, scored locally: gh answers "private", the scorecard CLI reads it with the gh token (child env only). */
function cmdScorecard(argv) {
  const { t } = pickTarget(argv);
  if (!t.gh) { process.stdout.write(`scorecard ${t.name}: no gh repo, skipped\n`); return; }
  const meta = src.ghApi(`repos/${t.gh}`);
  if (!meta.ok) { process.stderr.write(`scorecard ${t.name}: cannot ask GitHub (${meta.why})\n`); process.exitCode = 2; return; }
  if (!meta.data) { process.stderr.write(`scorecard ${t.name}: ${t.gh} not found (404)\n`); process.exitCode = 2; return; }
  if (meta.data.private !== true) { process.stdout.write(`scorecard ${t.name}: ${t.gh} is public, skipped (the public API scores it)\n`); return; }
  const tok = src.run("gh", ["auth", "token"], { timeout: 30_000 });
  const token = tok.ok && tok.data.status === 0 ? tok.data.stdout.trim() : "";
  if (!token) { process.stderr.write(`scorecard ${t.name}: no gh token (gh auth login)\n`); process.exitCode = 2; return; }
  const started = Date.now();
  // GitHub's GraphQL answers a passing 504 now and then; the CLI then prints "Skipping …" instead of
  // a reply. One retry, never more.
  const score = () => src.run("scorecard", [`--repo=github.com/${t.gh}`, "--format=json"], { timeout: 15 * 60_000, env: { ...process.env, GITHUB_AUTH_TOKEN: token } });
  let r = score();
  if (r.ok && r.data.status === 0 && !jsonLine(r.data.stdout)) r = score();
  if (!r.ok || r.data.status !== 0) { process.stderr.write(`scorecard ${t.name}: the scorecard CLI failed (${r.ok ? `exit ${r.data.status}: ${r.data.stderr.replace(token, "***").trim().slice(-200)}` : r.why})\n`); process.exitCode = 2; return; }
  let reply;
  try { reply = JSON.parse(jsonLine(r.data.stdout) ?? ""); } catch { process.stderr.write(`scorecard ${t.name}: the CLI's output was not JSON\n`); process.exitCode = 2; return; }
  if (typeof reply?.score !== "number" || !Array.isArray(reply.checks)) { process.stderr.write(`scorecard ${t.name}: the CLI's output has no score and checks\n`); process.exitCode = 2; return; }
  const dir = join(dirname(stateDir()), "scorecard", "local");
  const file = join(dir, `${t.gh.replace("/", "__")}.json`);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, r.data.stdout, { mode: 0o600 });
  renameSync(tmp, file);
  process.stdout.write(`scorecard ${t.name}: ${t.gh} scored locally ${reply.score}/10 in ${Math.round((Date.now() - started) / 1000)}s -> ${file}\n`);
}

async function cmdRun(argv) {
  if (argv.includes("--target")) {
    const { t, rest } = pickTarget(argv);
    const vars = { HOME: homedir(), SITE: process.env.EXPOSURE_SITE ?? "", NPM_2FA_CONFIRMED: process.env.EXPOSURE_NPM_2FA_CONFIRMED ?? "" };
    const unset = unsetTargetVars(t, vars);
    if (unset.length) die(unsetVarsSentence(t, unset), 64);
    argv = targetRunArgv(t, vars, rest);
  }
  const { pos, o } = parseArgs(argv, ["--name", "--gh", "--npm", "--vscode", "--vscode-manifest", "--release-repo", "--apk-cert", "--domain", "--npm-2fa-confirmed", "--play", "--play-key-missing", "--era-check", "--only"], ["--json", "--no-write", "--verbose"], ["--privacy-url"]);
  if (pos.length !== 1) die(USAGE);
  const dir = resolve(pos[0]);
  if (!existsSync(dir)) die(`no such directory: ${dir}`);
  const name = o.name ?? basename(dir);
  if (!validName(name)) die(`bad --name ${name}`);
  if (o.vscode && !o["vscode-manifest"]) die("--vscode needs --vscode-manifest <path>");
  if (o["apk-cert"] && !o["release-repo"]) die("--apk-cert needs --release-repo");
  const nowD = new Date(), now = nowD.toISOString();
  const { want, wantL, list: onlyList } = onlyFilter(o.only);
  const wantA = wantL("A"), wantB = wantL("B");
  const c7 = o.npm ? manualConfirmFinding(o.npm, o["npm-2fa-confirmed"], nowD) : null;
  if (c7?.error) die(c7.error);

  const prevText = existsSync(rowsFile(name)) ? src.readText(rowsFile(name)) : null;
  const prev = prevText?.ok ? readLastRow(prevText.data) : null;
  if (prev && JSON.stringify(prev.only ?? null) !== JSON.stringify(onlyList ?? null)) process.stderr.write(`warning: the last row of ${name} was ${prev.only ? `an --only ${prev.only.join(",")}` : "a full"} run and this one is ${onlyList ? `--only ${onlyList.join(",")}` : "a full run"}: findings are compared with it, so give an --only run its own --name\n`);
  const acc = readAccepts(name);
  if (!acc.ok) die(`${acceptsFile(name)} is unreadable (${acc.why}); fix or remove it`, 2); // before any network work
  const gitList = src.gitFiles(dir), listed = gitList.ok;
  const files = (() => {
    if (listed) return gitList.data;
    return ["package-lock.json", "npm-shrinkwrap.json", "package.json", "pyproject.toml"].filter((f) => existsSync(join(dir, f)));
  })();

  const parts = [];
  const npm = wantA ? await collectNpm(dir, files, listed) : { findings: [], absent: [], installScripts: new Set(), licences: new Set(), complete: false, skipped: true };
  parts.push(npm);
  if (wantA) parts.push(await collectOther(dir, files, nowD));
  const hasManifests = files.some((f) => /(^|\/)(package\.json|build\.gradle(\.kts)?|pyproject\.toml)$/.test(f));
  let settings = wantB ? {} : { ...(prev?.readings?.settings ?? {}) }; // a run without B carries the last B/C1 baseline
  if (o.gh && wantB) { const g = await collectGh(o.gh, hasManifests, nowD); parts.push(g); settings = { ...g.settings }; }
  else if (wantB) parts.push({ findings: [], absent: ["B1", "B2", "B3", "B4", "B5", "B6", "B7"].map((m) => absent(m, "no --gh given")) });
  if (o.npm && want("C1")) { const c = collectNpmPublished(o.npm); parts.push(c); Object.assign(settings, c.readings); }
  if (o.vscode && want("C3")) parts.push(await collectMarketplace(dir, o.vscode, o["vscode-manifest"], nowD));
  if (o["release-repo"] && want("C2")) parts.push(collectRelease(o["release-repo"], o["apk-cert"]));
  const stores = {};
  for (const [k, v] of Object.entries(prev?.readings?.stores ?? {})) if (!want(k.split(".")[0])) stores[k] = v; // measures not run keep their last reading
  if (o["privacy-url"]?.length && want("C5")) parts.push(await collectPrivacy(o["privacy-url"]));
  if (o.domain && want("C6")) { const c = await collectDomain(o.domain, nowD); parts.push(c); Object.assign(stores, c.stores); }
  if (c7 && want("C7")) parts.push(c7);
  if (o.play && want("D1")) { const c = collectTargetApi(dir, files, o.play, nowD); parts.push(c); Object.assign(stores, c.stores); }
  if (o.play && want("D2")) {
    const c = await collectPlayVitals(o.play, { keyFile: process.env.EXPOSURE_PLAY_KEY_FILE || undefined, missingWhy: o["play-key-missing"], now: nowD });
    parts.push(c); Object.assign(stores, c.readings ?? {});
  }
  if (o["era-check"] && want("D3")) { const c = collectEra(o["era-check"]); parts.push(c); Object.assign(stores, c.stores ?? {}); }

  const installScripts = [...npm.installScripts].sort();
  const prevReadings = prev?.readings ?? null;
  const stored = wantA ? installScriptReadings(prevReadings, installScripts, npm.complete) : prevReadings?.installScripts;
  if (wantA && !npm.complete) npm.absent.push(absent("A4", "a tracked lockfile was unreadable: the install-script baseline is kept from the last complete run"));
  // stores (C6/D1/D2) live beside settings, never in them: settingChanges diffs only `settings`
  const readings = { ...(stored ? { installScripts: stored } : {}), settings, licences: wantA ? [...npm.licences].sort() : (prevReadings?.licences ?? []), ...(Object.keys(stores).length ? { stores } : {}) };
  let findings = parts.flatMap((p) => p.findings);
  if (wantA) findings.push(...a4Findings(prevReadings, npm.complete ? installScripts : []));
  findings.push(...settingChanges(prevReadings?.settings ?? null, settings));
  findings = carryForward(prev, mergeAdvisories(findings), readings, now);
  findings = applyAccepts(findings, acc.data, nowD);
  const head = src.gitHead(dir);
  const row = { v: 1, at: now, repo: name, dir, ...(head ? { head } : {}), findings, absent: parts.flatMap((p) => p.absent ?? []), readings, ...(onlyList ? { only: onlyList } : {}), ...(prev ? {} : { firstRun: true }) };
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

/**
 * `era-seen --target <name>`: a person said every crash group ERA lists now is handled (the phone's
 * two-tap `era-seen` fix). The ERA checker records that itself (`--mark-seen`, its own state file and
 * contract; a group that grows or recurs is reported again); then the target is read again, so the
 * stored row says what is left instead of the phone guessing it. A checker that cannot reach ERA
 * marks nothing (it exits 2 before writing), and this says so and does not re-read.
 */
async function cmdEraSeen(argv) {
  const { t } = pickTarget(argv);
  const full = targetRunArgv(t, { HOME: homedir(), SITE: process.env.EXPOSURE_SITE ?? "" });
  const i = full.indexOf("--era-check");
  if (i < 0 || !full[i + 1]) die(`era-seen ${t.name}: this target has no --era-check script`);
  // the checker allows itself ~900 s (its fetch may fall back to a headless browser), as in collectEra
  const r = src.run("python3", [full[i + 1], "--mark-seen", "--json"], { timeout: 960_000 });
  const status = r.ok ? r.data.status : null;
  if (status !== 0 && status !== 10) {
    const why = r.ok ? (r.data.stderr.trim().split("\n").pop() || `exit ${status}`) : r.why;
    process.stderr.write(`era-seen ${t.name}: nothing marked seen — the ERA checker failed (${why})\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`era-seen ${t.name}: ERA's crash groups recorded as seen; reading again\n`);
  await cmdRun(["--target", t.name]);
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
else if (cmd === "targets") cmdTargets();
else if (cmd === "scorecard") cmdScorecard(rest);
else if (cmd === "accept") cmdAccept(rest);
else if (cmd === "show") cmdShow(rest);
else if (cmd === "era-seen") await cmdEraSeen(rest);
else die(USAGE);

