// node --test: the pure parsers of the exposure watch (tools/exposure/parse.mjs) — payload in,
// findings out. Fixtures are trimmed copies of the real API shapes with invented package names
// where a name would be private; nothing here touches npm, gh, git or the network.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ALLOW_LICENCES, apkCertFinding, dependabotFindings, eolFindings, eraFindings, manualConfirmFinding, privacyUrlFinding, rdapExpiryFinding, targetApiFinding, targetSdkFiles, targetSdkReadings, ghRepoSettings, licenceFindings, marketplaceFindings,
  npmAuditFindings, npmPublishedFindings, osvFindings, osvQueries, parseGradleDeps, parseLockfile, parsePyproject,
  parseVersionCatalog, registryFindings, secretScanningFindings, sha256Mismatches,
} from "./exposure/parse.mjs";

const NOW = new Date("2026-10-26T12:00:00Z");

test("parseLockfile: names from the last node_modules segment, direct only when hoisted and in a root manifest", () => {
  const { packages } = parseLockfile({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { ws: "^8", "node-pty": "1.2.0-beta.15" }, devDependencies: { vite: "^5" } },
      "packages/shared": { name: "@waterplane/shared", version: "0.1.0", dependencies: { zod: "^3" } },
      "node_modules/@waterplane/shared": { resolved: "packages/shared", link: true },
      "node_modules/ws": { version: "8.18.0", license: "MIT" },
      "node_modules/node-pty": { version: "1.2.0-beta.15", hasInstallScript: true, license: "MIT" },
      "node_modules/vite": { version: "5.4.0", dev: true, license: { type: "MIT" } },
      "node_modules/vite/node_modules/esbuild": { version: "0.21.0", dev: true, hasInstallScript: true },
      "node_modules/zod": { version: "3.23.0", license: "MIT" },
    },
  });
  const by = Object.fromEntries(packages.map((p) => [p.path, p]));
  assert.equal(by[""], undefined, "root skipped");
  assert.equal(by["node_modules/@waterplane/shared"], undefined, "links skipped");
  assert.equal(by["packages/shared"].name, "@waterplane/shared");
  assert.equal(by["node_modules/ws"].direct, true);
  assert.equal(by["node_modules/vite"].dev, true);
  assert.equal(by["node_modules/vite"].license, "MIT", "{type} licence object");
  assert.equal(by["node_modules/vite/node_modules/esbuild"].name, "esbuild");
  assert.equal(by["node_modules/vite/node_modules/esbuild"].direct, false);
  assert.equal(by["node_modules/vite/node_modules/esbuild"].hasInstallScript, true);
  assert.equal(by["node_modules/zod"].direct, true, "a workspace's own dependency counts as direct");
  assert.equal(by["node_modules/node-pty"].license, "MIT");
});

const AUDIT = {
  auditReportVersion: 2,
  vulnerabilities: {
    "left-pad": {
      name: "left-pad", severity: "high", isDirect: true,
      via: [{ source: 1101, name: "left-pad", dependency: "left-pad", title: "Prototype pollution", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", severity: "high", range: "<1.3.1" }],
      effects: ["wrapper"], range: "<1.3.1", nodes: ["node_modules/left-pad"], fixAvailable: true,
    },
    wrapper: { name: "wrapper", severity: "high", isDirect: false, via: ["left-pad"], effects: [], range: "*", nodes: ["node_modules/wrapper"] },
    qs: {
      name: "qs", severity: "moderate", isDirect: false,
      via: [{ source: 1102, name: "qs", dependency: "qs", title: "DoS", url: "https://github.com/advisories/GHSA-dddd-eeee-ffff", severity: "moderate", range: "<6.2.0" }],
      effects: [], range: "<6.2.0", nodes: ["node_modules/qs"],
    },
    ini: {
      name: "ini", severity: "moderate", isDirect: true,
      via: [{ source: 1103, name: "ini", dependency: "ini", title: "Odd", url: "https://github.com/advisories/GHSA-gggg-hhhh-iiii", severity: "moderate", range: "<1.0.0" }],
      effects: [], range: "<1.0.0", nodes: ["node_modules/ini"],
    },
  },
};

test("npmAuditFindings: one per advisory+package; via strings only produce nothing; moderate alerts only when direct", () => {
  const f = npmAuditFindings(AUDIT, "package-lock.json", new Set(["left-pad", "ini"]));
  assert.deepEqual(f.map((x) => x.key).sort(), ["adv:GHSA-aaaa-bbbb-cccc:left-pad", "adv:GHSA-dddd-eeee-ffff:qs", "adv:GHSA-gggg-hhhh-iiii:ini"]);
  const by = Object.fromEntries(f.map((x) => [x.subject, x]));
  assert.equal(by["left-pad"].level, "alert");
  assert.equal(by.qs.level, "digest", "transitive moderate");
  assert.equal(by.ini.level, "alert", "direct moderate");
  assert.equal(by.ini.direct, true);
  assert.equal(by.qs.measure, "A1");
  assert.deepEqual(by.qs.sources, ["npm audit package-lock.json"]);
  assert.equal(by.qs.advisory, "GHSA-dddd-eeee-ffff");
  assert.deepEqual(npmAuditFindings({ vulnerabilities: {} }, "x", new Set()), []);
  assert.deepEqual(npmAuditFindings({}, "x", new Set()), []);
});

const ALERT = (over = {}) => ({
  number: 7, state: "open", created_at: "2026-10-20T00:00:00Z",
  dependency: { package: { ecosystem: "npm", name: "tar" }, scope: "runtime" },
  security_advisory: { ghsa_id: "GHSA-1111-2222-3333", summary: "Arbitrary file write", severity: "medium" },
  security_vulnerability: { severity: "medium", package: { name: "tar" } },
  ...over,
});

test("dependabotFindings: medium becomes moderate; alert when high/critical or open over 14 days; closed ones ignored", () => {
  const [young] = dependabotFindings([ALERT()], NOW);
  assert.equal(young.severity, "moderate");
  assert.equal(young.level, "digest");
  assert.equal(young.key, "adv:GHSA-1111-2222-3333:tar");
  assert.equal(young.measure, "B1");
  const [old] = dependabotFindings([ALERT({ created_at: "2026-10-01T00:00:00Z" })], NOW);
  assert.equal(old.level, "alert");
  const [hi] = dependabotFindings([ALERT({ security_vulnerability: { severity: "high" } })], NOW);
  assert.equal(hi.level, "alert");
  assert.deepEqual(dependabotFindings([ALERT({ state: "fixed" })], NOW), []);
  assert.deepEqual(dependabotFindings({ message: "Not Found" }, NOW), [], "an error object is not a list");
});

test("A1 and B1 for one advisory on one package share a key", () => {
  const a = npmAuditFindings({ vulnerabilities: { tar: { via: [{ name: "tar", url: "https://github.com/advisories/GHSA-1111-2222-3333", severity: "moderate" }] } } }, "l", new Set());
  const [b] = dependabotFindings([ALERT()], NOW);
  assert.equal(a[0].key, b.key);
});

const packument = (latest, versions) => ({ "dist-tags": { latest }, versions });

test("registryFindings A2: a stable latest over an exact pre-release pin alerts; a newer pre-release on the channel digests", () => {
  const stable = registryFindings(packument("1.2.0", { "1.2.0-beta.15": {}, "1.2.0": {} }), { name: "node-pty", installed: "1.2.0-beta.15", declared: "1.2.0-beta.15", direct: true });
  const a2 = stable.find((f) => f.measure === "A2");
  assert.equal(a2.level, "alert");
  assert.equal(a2.key, "A2:node-pty", "no version in the key");
  const chan = registryFindings(packument("1.1.0", { "1.2.0-beta.15": {}, "1.2.0-beta.18": {}, "1.2.0-beta.9": {}, "1.2.0-rc.1": {} }), { name: "node-pty", installed: "1.2.0-beta.15", declared: "1.2.0-beta.15", direct: true });
  const d = chan.find((f) => f.measure === "A2");
  assert.equal(d.level, "digest");
  assert.match(d.text, /1\.2\.0-beta\.18/, "numeric identifiers compare as numbers (18 > 15 > 9)");
  const none = registryFindings(packument("1.1.0", { "1.2.0-beta.15": {} }), { name: "node-pty", installed: "1.2.0-beta.15", declared: "1.2.0-beta.15" });
  assert.equal(none.some((f) => f.measure === "A2"), false);
  const range = registryFindings(packument("2.0.0", { "1.0.0": {} }), { name: "x", installed: "1.0.0", declared: "^1.0.0" });
  assert.equal(range.some((f) => f.measure === "A2"), false, "a range is not a pin");
});

test("registryFindings A3: a deprecated installed version alerts when direct, digests when transitive", () => {
  const doc = packument("3.0.0", { "2.0.0": { deprecated: "use 3.x" }, "3.0.0": {} });
  const direct = registryFindings(doc, { name: "old", installed: "2.0.0", declared: "2.0.0", direct: true }).find((f) => f.measure === "A3");
  assert.equal(direct.level, "alert");
  assert.equal(direct.key, "A3:old@2.0.0");
  const trans = registryFindings(doc, { name: "old", installed: "2.0.0", direct: false }).find((f) => f.measure === "A3");
  assert.equal(trans.level, "digest");
  assert.equal(registryFindings(doc, { name: "old", installed: "3.0.0", direct: true }).length, 0);
});

test("registryFindings A6: only direct deps whose declared major is below latest's", () => {
  const doc = packument("5.1.0", { "3.0.0": {}, "5.1.0": {} });
  const f = registryFindings(doc, { name: "lib", installed: "3.0.0", declared: "^3.0.0", direct: true });
  assert.deepEqual(f.map((x) => [x.measure, x.level]), [["A6", "digest"]]);
  assert.equal(registryFindings(doc, { name: "lib", installed: "3.0.0", declared: "^3.0.0", direct: false }).length, 0);
  assert.equal(registryFindings(doc, { name: "lib", installed: "5.1.0", declared: "^5.0.0", direct: true }).length, 0);
  assert.equal(registryFindings(doc, { name: "lib", installed: "5.1.0", declared: "*", direct: true }).length, 0);
});

test("licenceFindings: allow-list, OR expressions pass on any allowed branch, AND needs all, missing licence alerts", () => {
  assert.ok(ALLOW_LICENCES.includes("BlueOak-1.0.0"));
  const f = licenceFindings([
    { name: "a", license: "MIT" },
    { name: "b", license: "(MIT OR GPL-3.0-only)" },
    { name: "c", license: "GPL-3.0-only" },
    { name: "d", license: null },
    { name: "e", license: "MIT AND GPL-2.0-only" },
    { name: "f", license: "(GPL-2.0-only OR LGPL-3.0)" },
    { name: "c", license: "GPL-3.0-only", version: "2" },
    { name: "g", license: "Apache-2.0 OR MIT" },
  ]);
  assert.deepEqual(f.map((x) => x.subject), ["c", "d", "e", "f"], "c once even with two versions");
  assert.ok(f.every((x) => x.level === "alert" && x.measure === "A5"));
  assert.match(f.find((x) => x.subject === "d").text, /no licence declared/);
  assert.equal(f[0].key, "A5:c");
  assert.equal(licenceFindings([{ name: "z", license: "Unlicense" }]).length, 1, "Unlicense is not on the list");
  assert.equal(licenceFindings([{ name: "z", license: "ISC" }], ["ISC"]).length, 0);
});

test("parseGradleDeps: string coordinates with versions; $var, no-version, dynamic and commented ones skipped", () => {
  const deps = parseGradleDeps(`
dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation 'org.yaml:snakeyaml:1.33'
    api("com.squareup.okhttp3:okhttp:\${okhttpVersion}")
    kapt("androidx.room:room-compiler:$roomVersion")
    ksp("com.google.dagger:hilt-compiler:2.51")
    implementation(platform("androidx.compose:compose-bom:2024.06.00"))
    implementation("androidx.compose.ui:ui")
    implementation("org.example:dyn:1.+")
    // implementation("org.example:old:0.1")
    testImplementation("junit:junit:4.13.2")
    implementation("io.pkg:thing:1.0:sources")
}
`);
  assert.deepEqual(deps.map((d) => `${d.group}:${d.artifact}:${d.version}`), [
    "androidx.core:core-ktx:1.13.1", "org.yaml:snakeyaml:1.33", "com.google.dagger:hilt-compiler:2.51",
    "androidx.compose:compose-bom:2024.06.00", "junit:junit:4.13.2", "io.pkg:thing:1.0",
  ]);
});

test("parseVersionCatalog: version.ref resolves through [versions]; inline versions, group+name and BOM-managed entries", () => {
  const libs = parseVersionCatalog(`
# comment
[versions]
kotlin = "2.0.0" # trailing
coil = { strictly = "2.6.0" }
compose-bom = "2024.06.00"

[libraries]
core = { module = "androidx.core:core-ktx", version.ref = "kotlin" }
coil = { group = "io.coil-kt", name = "coil", version.ref = "coil" }
inline = { module = "org.yaml:snakeyaml", version = "1.33" }
short = "com.squareup:okio:3.9.0"
bom = { module = "androidx.compose:compose-bom", version.ref = "compose-bom" }
ui = { module = "androidx.compose.ui:ui" }
multi = { module = "a.b:c",
  version = "9" }

[plugins]
android = { id = "com.android.application", version = "8.5.0" }
`);
  const s = libs.map((l) => `${l.group}:${l.artifact}:${l.version}`);
  assert.deepEqual(s, [
    "androidx.core:core-ktx:2.0.0", "io.coil-kt:coil:2.6.0", "org.yaml:snakeyaml:1.33", "com.squareup:okio:3.9.0",
    "androidx.compose:compose-bom:2024.06.00", "androidx.compose.ui:ui:null", "a.b:c:9",
  ]);
});

test("parsePyproject: floor from ==, ~=, >=; null for an upper bound alone; extras and markers stripped; optional deps included", () => {
  const deps = parsePyproject(`
[project]
name = "x"
dependencies = [
  "requests>=2.31,<3",
  "click[extra]==8.1.*",  # pinned
  "pyyaml~=6.0",
  "oldlib<2",
  "bare",
  'typer >=0.12 ; python_version >= "3.9"',
]

[project.optional-dependencies]
dev = ["pytest>=8"]
`);
  const by = Object.fromEntries(deps.map((d) => [d.name, d]));
  assert.equal(by.requests.floor, "2.31");
  assert.equal(by.requests.spec, ">=2.31,<3");
  assert.equal(by.click.floor, "8.1");
  assert.equal(by.pyyaml.floor, "6.0");
  assert.equal(by.oldlib.floor, null, "< only says nothing about what runs");
  assert.equal(by.bare.floor, null);
  assert.equal(by.typer.floor, "0.12");
  assert.equal(by.typer.spec, ">=0.12");
  assert.equal(by.pytest.floor, "8");
  assert.equal(deps.length, 7);
});

const OSV_BATCH = { results: [{ vulns: [{ id: "GHSA-w285-3p4w-4xcc", modified: "2024-01-01T00:00:00Z" }] }, {}, { vulns: [{ id: "PYSEC-2023-1" }] }] };
const OSV_VULN = {
  id: "GHSA-w285-3p4w-4xcc", aliases: ["CVE-2022-1471"], summary: "SnakeYAML constructor RCE",
  database_specific: { severity: "CRITICAL" },
  severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
};

test("osvQueries: Maven and PyPI bodies; versionless deps come back separately, in query order for osvFindings", () => {
  const q = osvQueries([
    { group: "org.yaml", artifact: "snakeyaml", version: "1.33" },
    { group: "androidx.compose.ui", artifact: "ui", version: null },
  ], "Maven");
  assert.deepEqual(q.body, { queries: [{ package: { name: "org.yaml:snakeyaml", ecosystem: "Maven" }, version: "1.33" }] });
  assert.equal(q.unversioned.length, 1);
  assert.equal(q.queried.length, 1);
  const py = osvQueries([{ name: "requests", floor: "2.31" }, { name: "oldlib", floor: null }], "PyPI");
  assert.deepEqual(py.body.queries, [{ package: { name: "requests", ecosystem: "PyPI" }, version: "2.31" }]);
  assert.deepEqual(py.unversioned.map((d) => d.name), ["oldlib"]);
});

test("osvFindings: GHSA alias preferred, label severity wins, CVSS vector is the fallback, default moderate", () => {
  const deps = [
    { group: "org.yaml", artifact: "snakeyaml", version: "1.33" }, { group: "x", artifact: "clean", version: "1" }, { group: "py", artifact: "pylib", version: "1.0" },
  ];
  const f = osvFindings(OSV_BATCH, deps, { "GHSA-w285-3p4w-4xcc": OSV_VULN, "PYSEC-2023-1": { id: "PYSEC-2023-1", aliases: ["CVE-2023-1"], summary: "bad" } });
  assert.equal(f.length, 2);
  assert.equal(f[0].key, "adv:GHSA-w285-3p4w-4xcc:org.yaml:snakeyaml");
  assert.equal(f[0].severity, "critical");
  assert.equal(f[0].level, "alert");
  assert.deepEqual(f[0].sources, ["osv"]);
  assert.equal(f[0].version, "1.33");
  assert.equal(f[1].advisory, "PYSEC-2023-1", "no GHSA alias: the OSV id");
  assert.equal(f[1].severity, "moderate");
  const viaVector = osvFindings({ results: [{ vulns: [{ id: "OSV-1" }] }] }, [deps[0]], {
    "OSV-1": { id: "OSV-1", severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }] },
  });
  assert.equal(viaVector[0].severity, "critical", "9.8 from the vector");
  const low = osvFindings({ results: [{ vulns: [{ id: "OSV-2" }] }] }, [deps[0]], { "OSV-2": { id: "OSV-2", severity: [{ score: "3.1" }] } });
  assert.equal(low[0].severity, "low");
  assert.equal(low[0].level, "digest");
});

test("osvFindings: an id whose detail lookup failed is skipped, never alerted with a guessed severity", () => {
  const deps = [{ group: "org.yaml", artifact: "snakeyaml", version: "1.33" }];
  assert.deepEqual(osvFindings({ results: [{ vulns: [{ id: "PYSEC-9" }] }] }, deps, {}), []);
});

// trimmed, real-shaped OSV records for an invented PyPI package declared as `>=10.0`
const FLOOR_BATCH = { results: [{ vulns: [{ id: "PYSEC-1" }, { id: "GHSA-aaaa-bbbb-cccc" }, { id: "GHSA-dddd-eeee-ffff" }] }] };
const floorVuln = (id, severity, fixed, extra = {}) => ({
  id, aliases: extra.aliases ?? [], summary: `${id} summary`, database_specific: { severity },
  affected: [{ package: { name: "Fancy_Lib", ecosystem: "PyPI" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, ...(fixed ? [{ fixed }] : [])] }] }],
});

test("osvFindings: a declared FLOOR groups its advisories into one A1 finding with the lowest all-fixing version", () => {
  const deps = [{ name: "fancy-lib", floor: "10.0" }];
  const details = {
    "PYSEC-1": floorVuln("PYSEC-1", "MODERATE", "10.3.1", { aliases: ["GHSA-aaaa-bbbb-cccc"] }),
    "GHSA-aaaa-bbbb-cccc": floorVuln("GHSA-aaaa-bbbb-cccc", "HIGH", "10.2.0"),
    "GHSA-dddd-eeee-ffff": floorVuln("GHSA-dddd-eeee-ffff", "LOW", "11.0.0"),
  };
  const f = osvFindings(FLOOR_BATCH, deps, details);
  assert.equal(f.length, 1);
  assert.equal(f[0].key, "A1:fancy-lib@10.0");
  assert.equal(f[0].severity, "high");
  assert.equal(f[0].level, "alert");
  assert.deepEqual(f[0].advisories, ["GHSA-aaaa-bbbb-cccc", "GHSA-dddd-eeee-ffff"], "PYSEC-1 and its GHSA alias are one advisory");
  assert.equal(f[0].text, "declared floor fancy-lib 10.0 admits 2 known advisories (highest: high); lowest version fixing all: 11.0.0");
  // one advisory without a fix: unknown
  const nofix = osvFindings(FLOOR_BATCH, deps, { ...details, "GHSA-dddd-eeee-ffff": floorVuln("GHSA-dddd-eeee-ffff", "LOW", null) });
  assert.match(nofix[0].text, /lowest version fixing all: unknown$/);
  // raising the floor changes the key: a new finding
  assert.equal(osvFindings(FLOOR_BATCH, [{ name: "fancy-lib", floor: "11.0" }], details)[0].key, "A1:fancy-lib@11.0");
  // an exact-version dep keeps one finding per advisory
  const exact = osvFindings(FLOOR_BATCH, [{ group: "g", artifact: "a", version: "1.0" }], details);
  assert.equal(exact.length, 2);
  assert.ok(exact.every((x) => x.key.startsWith("adv:")));
});

const REPO = (over = {}) => ({
  owner: { type: "Organization" },
  security_and_analysis: {
    secret_scanning: { status: "enabled" }, secret_scanning_push_protection: { status: "disabled" },
    dependabot_security_updates: { status: "enabled" },
  },
  ...over,
});

test("ghRepoSettings: readings as strings, B5 write alerts every run, B7 when manifests lack dependabot.yml", () => {
  const r = ghRepoSettings({
    repo: REPO(), workflowPerms: { default_workflow_permissions: "write" }, protection: null, rulesets: [{ id: 1 }],
    org: { two_factor_requirement_enabled: false }, dependabotConfigPresent: false, hasManifests: true,
  });
  assert.deepEqual(r.settings, { B2: "scanning on, push protection off", B3: "on", B4: "ruleset", B5: "write", B6: "off" });
  assert.deepEqual(r.findings.map((f) => [f.measure, f.level]), [["B5", "alert"], ["B7", "digest"]]);
  assert.deepEqual(r.absent, []);
  const none = ghRepoSettings({ repo: REPO(), workflowPerms: { default_workflow_permissions: "read" }, protection: null, rulesets: [], org: { two_factor_requirement_enabled: true }, dependabotConfigPresent: true, hasManifests: true });
  assert.equal(none.settings.B4, "none");
  assert.equal(none.settings.B5, "read");
  assert.deepEqual(none.findings.map((f) => [f.key, f.level]), [["B4:default-branch", "digest"]]);
  const prot = ghRepoSettings({ repo: REPO(), protection: { required_status_checks: {} }, rulesets: [] });
  assert.equal(prot.settings.B4, "protection");
});

test("ghRepoSettings: B6 null is absent, not off; a user-owned repo is absent 'not an org'; unreadable settings are absent", () => {
  const nullB6 = ghRepoSettings({ repo: REPO(), workflowPerms: { default_workflow_permissions: "read" }, protection: null, rulesets: [], org: { two_factor_requirement_enabled: null } });
  assert.equal("B6" in nullB6.settings, false);
  assert.match(nullB6.absent.find((a) => a.measure === "B6").why, /not readable/);
  const user = ghRepoSettings({ repo: REPO({ owner: { type: "User" } }), org: null });
  assert.match(user.absent.find((a) => a.measure === "B6").why, /not owned by an organisation/);
  assert.ok(user.absent.every((a) => a.unreachable === false));
  const blind = ghRepoSettings({ repo: { owner: { type: "Organization" } } });
  assert.deepEqual(blind.absent.map((a) => a.measure).sort(), ["B2", "B3", "B4", "B5", "B6"]);
  assert.deepEqual(blind.settings, {});
});

test("ghRepoSettings B4: Scorecard fills it only when gh cannot read it", () => {
  const b4 = (extra) => ghRepoSettings({ repo: REPO(), ...extra });
  const sc = (score) => ({ score, reason: "r", date: "2026-10-26" });
  assert.equal(b4({ scorecardBranch: sc(0) }).settings.B4, "none");
  assert.equal(b4({ scorecardBranch: sc(8) }).settings.B4, "protection");
  assert.equal(b4({ scorecardBranch: sc(9) }).settings.B4, "protection"); // a re-score does not change the diffed value
  assert.deepEqual(b4({ scorecardBranch: sc(8) }).notes.B4, { source: "scorecard", score: 8, date: "2026-10-26" });
  assert.equal(b4({ protection: null, rulesets: [] }).notes.B4, undefined);
  for (const s of [sc(-1), null]) {
    const r = b4({ scorecardBranch: s });
    assert.equal(r.settings.B4, undefined);
    assert.match(r.absent.find((a) => a.measure === "B4").why, /Scorecard.*inconclusive or not scored/);
  }
  assert.doesNotMatch(b4({}).absent.find((a) => a.measure === "B4").why, /Scorecard/);
  // gh readable: the Scorecard input is ignored, values unchanged
  assert.equal(b4({ protection: null, rulesets: [], scorecardBranch: sc(9) }).settings.B4, "none");
  assert.equal(b4({ protection: { x: 1 }, scorecardBranch: sc(0) }).settings.B4, "protection");
});

test("secretScanningFindings: an alert per open alert", () => {
  const f = secretScanningFindings([
    { number: 3, state: "open", secret_type_display_name: "GitHub Personal Access Token" },
    { number: 4, state: "resolved", secret_type_display_name: "x" },
  ]);
  assert.equal(f.length, 1);
  assert.equal(f[0].measure, "B2");
  assert.equal(f[0].level, "alert");
  assert.match(f[0].text, /#3.*GitHub Personal Access Token/);
  assert.deepEqual(secretScanningFindings({ message: "Not Found" }), []);
});

const CYCLES = [
  { cycle: "24", eol: "2028-04-30", lts: "2024-10-29" },
  { cycle: "20", eol: "2026-04-30" },
  { cycle: "22", eol: "2026-12-15" },
  { cycle: "26", eol: false },
];

test("eolFindings: alert within 90 days or past; quiet beyond; unknown cycle is absent", () => {
  const past = eolFindings(CYCLES, "nodejs", 20, NOW);
  assert.equal(past.findings[0].level, "alert");
  assert.match(past.findings[0].text, /reached end of life/);
  assert.equal(past.findings[0].key, "A7:nodejs@20");
  const soon = eolFindings(CYCLES, "nodejs", 22, NOW);
  assert.equal(soon.findings.length, 1, "50 days out");
  assert.match(soon.findings[0].text, /50 days/);
  assert.deepEqual(eolFindings(CYCLES, "nodejs", 24, NOW), { findings: [], absent: [] });
  assert.deepEqual(eolFindings(CYCLES, "nodejs", 26, NOW), { findings: [], absent: [] }, "eol: false");
  const done = eolFindings([{ cycle: "3", eol: true }], "nodejs", 3, NOW);
  assert.equal(done.findings.length, 1, "eol: true is end of life with no date");
  assert.match(done.findings[0].text, /is end of life \(no date listed\)/);
  assert.equal(done.findings[0].level, "alert");
  const unk = eolFindings(CYCLES, "nodejs", 99, NOW);
  assert.equal(unk.findings.length, 0);
  assert.equal(unk.absent[0].measure, "A7");
});

test("npmPublishedFindings: deprecated latest alerts; readings carry maintainers and dist-tags; expectations alert at once", () => {
  const view = { name: "waterplane", "dist-tags": { latest: "0.1.6", next: "0.2.0-rc.1" }, maintainers: ["alice <a@example.com>", "bob <b@example.com>"] };
  const ok = npmPublishedFindings(view);
  assert.deepEqual(ok.findings, []);
  assert.deepEqual(ok.readings, { maintainers: ["alice", "bob"], distTags: { latest: "0.1.6", next: "0.2.0-rc.1" } });
  const dep = npmPublishedFindings({ ...view, deprecated: "do not use" });
  assert.equal(dep.findings[0].level, "alert");
  const strict = npmPublishedFindings(view, { expectMaintainers: ["alice"], expectDistTags: [] });
  assert.equal(strict.findings.length, 2);
  assert.ok(strict.findings.every((f) => f.measure === "C1"));
  assert.deepEqual(npmPublishedFindings({ ...view, maintainers: [{ name: "bob" }, { name: "alice" }] }).readings.maintainers, ["alice", "bob"]);
});

const MARKET = (over = {}) => ({ results: [{ extensions: [{ extensionName: "demo-ext", flags: "validated, public", versions: [{ version: "0.6.1" }], ...over }] }] });

test("marketplaceFindings: unlisted or unpublished alerts; version drift alerts only once the local version is over 7 days old", () => {
  const opts = { localVersion: "0.6.1", localVersionDate: "2026-10-01T00:00:00Z", now: NOW };
  assert.deepEqual(marketplaceFindings(MARKET(), opts), []);
  assert.equal(marketplaceFindings({ results: [{ extensions: [] }] }, opts)[0].level, "alert");
  assert.match(marketplaceFindings(MARKET({ flags: "unpublished" }), opts)[0].text, /unpublished/);
  assert.equal(marketplaceFindings(MARKET(), { ...opts, localVersion: "0.6.2" }).length, 1);
  assert.equal(marketplaceFindings(MARKET(), { ...opts, localVersion: "0.6.2", localVersionDate: "2026-10-24T00:00:00Z" }).length, 0, "two days old: still propagating");
  assert.equal(marketplaceFindings(MARKET(), opts)[0], undefined);
});

test("sha256Mismatches: first hex token of the .sha256 against the asset; Buffer or string; missing asset or digest alerts", () => {
  const sum = (s) => createHash("sha256").update(s).digest("hex");
  const good = sha256Mismatches({ "a.tar.gz": Buffer.from("abc"), "a.tar.gz.sha256": `${sum("abc")}  a.tar.gz\n` });
  assert.deepEqual(good, []);
  const upper = sha256Mismatches({ "a.bin": "abc", "a.bin.sha256": sum("abc").toUpperCase() });
  assert.deepEqual(upper, []);
  const bad = sha256Mismatches({ "a.tar.gz": Buffer.from("tampered"), "a.tar.gz.sha256": Buffer.from(`${sum("abc")}  a.tar.gz`) });
  assert.equal(bad.length, 1);
  assert.equal(bad[0].measure, "C2");
  assert.equal(bad[0].subject, "a.tar.gz");
  assert.equal(sha256Mismatches({ "b.sha256": "garbage" }).length, 1);
  assert.equal(sha256Mismatches({ "c.apk.sha256": sum("x") }).length, 1, "no asset beside it");
  assert.deepEqual(sha256Mismatches({ "other.txt": "x" }), []);
});

test("apkCertFinding: colon/case-insensitive match is quiet; a different signer alerts; no line is absent", () => {
  const hex = "ab".repeat(32);
  const out = `Verifies\nSigner #1 certificate DN: CN=Demo\nSigner #1 certificate SHA-256 digest: ${hex}\nSigner #1 certificate SHA-1 digest: 00\n`;
  assert.deepEqual(apkCertFinding(out, hex.toUpperCase()), { findings: [], absent: [] });
  assert.deepEqual(apkCertFinding(out, hex.match(/../g).join(":")), { findings: [], absent: [] });
  const bad = apkCertFinding(out, "cd".repeat(32));
  assert.equal(bad.findings[0].level, "alert");
  assert.equal(bad.findings[0].measure, "C2");
  const none = apkCertFinding("DOES NOT VERIFY", hex);
  assert.equal(none.findings.length, 0);
  assert.equal(none.absent[0].measure, "C2");
});

test("licenceFindings: a workspace package of our own is not a dependency (real npm workspaces lockfile)", () => {
  const { packages } = parseLockfile({
    lockfileVersion: 3,
    packages: {
      "": { workspaces: ["packages/*"], dependencies: { leftpad: "^1" } },
      "packages/app": { name: "@acme/app", version: "1.0.0" }, // no licence field: ours
      "node_modules/@acme/app": { resolved: "packages/app", link: true },
      "node_modules/leftpad": { version: "1.0.0" }, // a real dependency with none: still an alert
    },
  });
  assert.deepEqual(licenceFindings(packages).map((x) => x.subject), ["leftpad"]);
});

// ---- phase 3 -------------------------------------------------------------------------------------------

test("privacyUrlFinding: 200 is silent, another final status is a high alert, no answer is absent", () => {
  assert.deepEqual(privacyUrlFinding("https://example.test/p", { ok: true, status: 200, finalUrl: "https://example.test/p" }), { findings: [], absent: [] });
  const r = privacyUrlFinding("https://example.test/p", { ok: true, status: 404, finalUrl: "https://example.test/gone" });
  assert.equal(r.findings[0].key, "C5:https://example.test/p");
  assert.equal(r.findings[0].severity, "high");
  assert.match(r.findings[0].text, /404.*https:\/\/example\.test\/gone/);
  const a = privacyUrlFinding("https://example.test/p", { ok: false, why: "timeout" });
  assert.equal(a.absent[0].measure, "C5"); assert.equal(a.absent[0].unreachable, true); assert.deepEqual(a.findings, []);
});

test("rdapExpiryFinding: 45-day edge, past is critical, version is the date, no event is absent", () => {
  const rd = (d) => ({ events: [{ eventAction: "registration", eventDate: "2010-01-01T00:00:00Z" }, { eventAction: "expiration", eventDate: d }] });
  assert.deepEqual(rdapExpiryFinding(rd("2026-12-31T00:00:00Z"), "example.test", NOW).findings, []);
  assert.equal(rdapExpiryFinding(rd("2026-12-31T00:00:00Z"), "example.test", NOW).reading, "2026-12-31");
  const edge = rdapExpiryFinding(rd("2026-12-10T12:00:00Z"), "example.test", NOW); // exactly 45 days
  assert.equal(edge.findings[0].key, "C6:domain:example.test@2026-12-10");
  assert.notEqual(edge.findings[0].severity, "critical");
  assert.deepEqual(rdapExpiryFinding(rd("2026-12-11T12:00:00Z"), "example.test", NOW).findings, []);
  const gone = rdapExpiryFinding(rd("2026-10-01T00:00:00Z"), "example.test", NOW);
  assert.equal(gone.findings[0].severity, "critical"); assert.match(gone.findings[0].text, /expired/);
  const t1 = rdapExpiryFinding(rd("2026-12-10T12:00:00Z"), "example.test", NOW).findings[0].text;
  const t2 = rdapExpiryFinding(rd("2026-12-10T12:00:00Z"), "example.test", new Date("2026-11-20T12:00:00Z")).findings[0].text;
  assert.equal(t1, t2, "no countdown in the text"); assert.match(t1, /2026-12-10/); assert.doesNotMatch(t1, /\bdays\b/);
  assert.equal(rdapExpiryFinding({ events: [] }, "example.test", NOW).absent[0].measure, "C6");
});

test("manualConfirmFinding: no date absent, 365/335 day edges, bad and future dates are errors", () => {
  assert.match(manualConfirmFinding("pkg", undefined, NOW).absent[0].why, /--npm-2fa-confirmed <date>/);
  assert.match(manualConfirmFinding("pkg", "26-1-1", NOW).error, /bad/);
  assert.match(manualConfirmFinding("pkg", "2026-02-31", NOW).error, /bad/);
  assert.match(manualConfirmFinding("pkg", "2026-10-27", NOW).error, /future/);
  assert.deepEqual(manualConfirmFinding("pkg", "2026-10-26", NOW), { findings: [], absent: [] });
  assert.deepEqual(manualConfirmFinding("pkg", "2025-12-01", NOW).findings, []); // 329 days
  const d = manualConfirmFinding("pkg", "2025-11-26", NOW).findings[0]; // 334.5 -> 334
  assert.equal(d, undefined);
  const due = manualConfirmFinding("pkg", "2025-11-25", NOW).findings[0]; // 335
  assert.equal(due.level, "digest"); assert.match(due.text, /due within 30 days/); assert.equal(due.key, "C7:npm:pkg:2fa");
  assert.equal(manualConfirmFinding("pkg", "2025-10-26", NOW).findings[0].level, "digest"); // 365
  const old = manualConfirmFinding("pkg", "2025-10-25", NOW).findings[0];
  assert.equal(old.level, "alert"); assert.match(old.text, /last confirmed 2025-10-25, over 12 months ago/);
});

test("targetSdkReadings: literal forms, lowest of several, indirection resolved only by a literal, none is null", () => {
  const r = targetSdkReadings([
    { path: "app/build.gradle", text: "android {\n  defaultConfig {\n    targetSdkVersion rootProject.ext.targetSdkVersion\n    minSdk 24\n  }\n}" },
    { path: "variables.gradle", text: "ext {\n  targetSdkVersion = 36\n  compileSdkVersion = 36\n}" },
  ]);
  assert.deepEqual([r.value, r.file], [36, "variables.gradle"]);
  assert.equal(targetSdkReadings([{ path: "app/build.gradle", text: "targetSdkVersion rootProject.ext.targetSdkVersion" }]), null);
  assert.equal(targetSdkReadings([{ path: "a.gradle.kts", text: "// targetSdk = 20\n  targetSdk = 35" }]).value, 35);
  const forms = [["targetSdk = 36", 36], ["targetSdkVersion 35", 35], ['targetSdk = "34"', 34], ["build --target-sdk-version 33 x", 33], ['<uses-sdk android:targetSdkVersion="32"/>', 32]];
  for (const [text, v] of forms) assert.equal(targetSdkReadings([{ path: "f", text }]).value, v, text);
  const low = targetSdkReadings([{ path: "a/build.gradle", text: "targetSdk = 36" }, { path: "libs.versions.toml", text: 'targetSdk = "34"' }]);
  assert.deepEqual([low.value, low.file], [34, "libs.versions.toml"]);
  assert.equal(targetSdkReadings([{ path: "f", text: "compileSdk = 36\nminSdk = 24" }]), null);
});

test("targetSdkFiles: build files count, template/fixture/test/example paths do not", () => {
  const files = ["packages/app/android/variables.gradle", "packages/host/templates/android-hello/app/build.gradle.kts", "x/fixtures/a/build.gradle", "tests/b/build.gradle", "examples/c/AndroidManifest.xml", "app/src/__tests__/build.gradle", "build.sh", "templates/build.sh", "README.md"];
  assert.deepEqual(targetSdkFiles(files), ["packages/app/android/variables.gradle", "build.sh"]);
});

test("targetApiFinding: the 31 Aug edge, the 60-day window, the yearly re-key and 'expected' past the table", () => {
  const at = (s) => new Date(s);
  const f = (sdk, when) => targetApiFinding(sdk, "app/build.gradle", at(when), "com.example.app");
  // 2026-08-31 (the day itself): 2026's deadline has not passed; 2025's did and is met by 35
  assert.deepEqual(f(35, "2026-08-31T12:00:00Z").map((x) => x.severity), ["moderate"]);
  assert.equal(f(35, "2026-08-31T12:00:00Z")[0].version, "36");
  assert.deepEqual(f(35, "2026-09-01T00:00:00Z").map((x) => x.severity), ["high"]); // passed
  assert.equal(f(35, "2026-09-01T00:00:00Z")[0].key, "D1:play:com.example.app:targetSdk@36");
  assert.deepEqual(f(36, "2026-09-01T00:00:00Z"), []);
  assert.deepEqual(f(35, "2026-07-02T00:00:00Z").map((x) => x.severity), ["moderate"]); // 60 days left
  assert.deepEqual(f(35, "2026-07-01T00:00:00Z"), []); // 61 days: outside the window
  assert.equal(f(35, "2026-07-02T00:00:00Z")[0].text, f(35, "2026-08-01T00:00:00Z")[0].text, "no countdown in the text");
  assert.deepEqual(f(34, "2026-01-10T00:00:00Z").map((x) => x.severity), ["high"]); // 2025's deadline missed
  assert.equal(f(34, "2026-01-10T00:00:00Z")[0].version, "35");
  // a year past the table: formula, worded as expected
  const late = f(36, "2027-07-15T00:00:00Z");
  assert.equal(late[0].version, "37"); assert.match(late[0].text, /expected/);
  assert.doesNotMatch(f(35, "2026-09-01T00:00:00Z")[0].text, /expected/);
});

test("eraFindings: exit 0 nothing, 10 one alert per group, 2 unreachable, garbage unreachable with words", () => {
  assert.deepEqual(eraFindings(0, "", ""), { findings: [], absent: [] });
  const out = JSON.stringify([{ key: "appA/prod/Boom/1.2.3/Foo.mc:42", app: "appA", channel: "prod", error: "Boom", version: "1.2.3", count: 7, last: "2026-10-25", top: "Foo.mc:42" }, { key: "appA/prod/Bang/1.2.3/Bar.mc:1", app: "appA", channel: "prod", error: "Bang", version: "1.2.3", count: 1, last: "2026-10-24", top: "Bar.mc:1" }]);
  const r = eraFindings(10, out, "");
  assert.equal(r.findings.length, 2);
  assert.equal(r.findings[0].severity, "high");
  assert.equal(r.findings[0].key, "D3:ciq:appA/prod/Boom/1.2.3/Foo.mc:42#1+");
  assert.equal(r.findings[0].text, "appA prod v1.2.3: Boom, 1+ times (top Foo.mc:42); the count is in the row");
  assert.deepEqual(r.stores, { "D3.appA/prod/Boom/1.2.3/Foo.mc:42.count": "7", "D3.appA/prod/Bang/1.2.3/Bar.mc:1.count": "1" });
  const at = (n) => eraFindings(10, JSON.stringify([{ key: "k", app: "a", channel: "c", error: "E", version: "1", count: n, last: "d", top: "t" }]), "").findings[0];
  assert.deepEqual([9, 10, 99, 100, 1234, 99999, 5e6].map((n) => /#(\d+)\+$/.exec(at(n).subject)[1]), ["1", "10", "10", "100", "1000", "10000", "10000"]);
  assert.equal(at(12).text, at(95).text, "stable inside a bucket"); assert.notEqual(at(95).key, at(100).key);
  const two = eraFindings(2, "", "noise\nlogin failed\n");
  assert.equal(two.absent[0].unreachable, true); assert.match(two.absent[0].why, /login failed/);
  for (const [st, so] of [[10, "not json"], [10, "{}"], [10, "[]"], [1, ""], [null, ""]]) {
    const g = eraFindings(st, so, "");
    assert.deepEqual(g.findings, []); assert.equal(g.absent[0].measure, "D3"); assert.equal(g.absent[0].unreachable, true);
  }
});
