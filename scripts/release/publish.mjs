#!/usr/bin/env node
// Publish a release in one command: tag, public snapshot, GitHub release with every asset, npm,
// then download it all back and check it. DRY RUN unless --yes: the dry run makes only read-only
// calls (git, gh/npm status and view) and prints every command the real run would make.
//
//   npm run release:publish -- [--yes] [--build [--apk=<file.apk>]] [--public-clone <dir>]
//                              [--accept <file>] [--allow-dirty] [--no-apk]
//
//   --yes             really publish. Without it nothing is written, tagged, pushed or uploaded.
//   --build           run `npm run release:build` first (else dist-release/ must already hold it)
//   --apk=<file>      passed to release:build (with --build)
//   --public-clone    a local clone of github.com/<org>/<slug>, for release:public. Needed
//                     until the GitHub release exists.
//   --accept <file>   passed to release:public (reviewed scan false positives)
//   --allow-dirty     dry run only: waive the clean-tree / main / built-from-HEAD checks
//   --no-apk          publish without an Android APK asset, on purpose (else undrafting refuses)
//
// A re-run resumes: each step says whether it is already done (tag on HEAD and origin, release
// present, assets uploaded, version on npm) and is skipped then, so a run that died after the
// GitHub release and before npm finishes the npm part and never publishes anything twice.
// Pure parts: publish-lib.mjs. Why each step: docs/notes/distribution.md.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractChangelogSection, planSteps, preflight, readHasShrinkwrap, releaseAssets, sha256Hex, shellLine, tagOf,
  verifyReleaseBytes,
} from "./publish-lib.mjs";
import { PUBKEY_PATH, loadPublicKey } from "./sign-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = "dist-release";

// ── args ───────────────────────────────────────────────────────────────────
const opts = { yes: false, build: false, allowDirty: false, noApk: false, apk: null, publicClone: null, accept: null };
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (name) => {
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
      const v = argv[++i];
      if (v === undefined) die(`${name} needs a value`);
      return v;
    };
    if (a === "--yes") opts.yes = true;
    else if (a === "--build") opts.build = true;
    else if (a === "--allow-dirty") opts.allowDirty = true;
    else if (a === "--no-apk") opts.noApk = true;
    else if (a.startsWith("--apk=")) opts.apk = resolve(a.slice(6));
    else if (a === "--public-clone" || a.startsWith("--public-clone=")) opts.publicClone = resolve(val("--public-clone"));
    else if (a === "--accept" || a.startsWith("--accept=")) opts.accept = resolve(val("--accept"));
    else if (a === "-h" || a === "--help") { console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 21).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")); process.exit(0); }
    else die(`unknown argument ${a}`);
  }
  if (opts.apk && !opts.build) die("--apk goes with --build (it is a release:build flag)");
  if (opts.apk && opts.noApk) die("--apk and --no-apk contradict each other");
}
function die(msg, code = 2) { console.error(`release:publish: ${msg}`); process.exit(code); }

/** Run read-only, never throwing: { ok, out, err }. */
function run(cmd, args, o = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28, ...o });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() + (r.error ? String(r.error.message) : "") };
}

// ── identity ───────────────────────────────────────────────────────────────
if (!existsSync(join(ROOT, "packages/shared/dist/brand.js"))) die("packages/shared/dist is missing: npm run build:shared first", 1);
const { BRAND, releaseApkName } = await import(join(ROOT, "packages/shared/dist/brand.js"));
const SLUG = BRAND.slug;
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const TAG = tagOf(version);
const REPO = `${BRAND.githubOrg}/${SLUG}`;
const PKG = SLUG; // the npm package name is the slug (build.mjs writes `name: SLUG`)
const out = (n) => join(ROOT, DIR, n);

console.log(`release:publish ${BRAND.name} ${version} → github.com/${REPO} (${TAG}) and npm ${PKG}  ${opts.yes ? "[REAL RUN]" : "[dry run: nothing is changed]"}`);

// ── facts ──────────────────────────────────────────────────────────────────
function readLocal() {
  let rj = null;
  try { rj = JSON.parse(readFileSync(out("release.json"), "utf8")); } catch { /* reported as missing */ }
  const assets = releaseAssets({ slug: SLUG, version, apk: rj?.apk ?? null });
  const missingLocal = assets.filter((a) => a.local && !existsSync(out(a.name))).map((a) => a.name);
  const files = {};
  for (const a of assets) if (a.local && existsSync(out(a.name)) && a.role !== "npm" && a.role !== "apk") files[a.name] = readFileSync(out(a.name));
  for (const s of ["sha256", "release-json"]) {
    const a = assets.find((x) => x.role === s);
    if (a && existsSync(out(`${a.name}.sig`))) files[`${a.name}.sig`] = readFileSync(out(`${a.name}.sig`));
  }
  const pub = loadPublicKey(readFileSync(join(ROOT, PUBKEY_PATH), "utf8"));
  const byteProblems = missingLocal.length ? [] : verifyReleaseBytes(files, pub, { slug: SLUG, version });
  const npmTgz = assets.find((a) => a.role === "npm").name;
  const listing = existsSync(out(npmTgz)) ? run("tar", ["-tzf", out(npmTgz)]) : { ok: false, out: "" };
  const npmHasShrinkwrap = listing.ok && listing.out.split("\n").includes("package/npm-shrinkwrap.json");
  return { assets, missingLocal, byteProblems, releaseCommit: rj?.commit ?? null, npmHasShrinkwrap };
}

function releaseState() {
  const r = run("gh", ["release", "view", TAG, "--repo", REPO, "--json", "isDraft,assets"]);
  if (r.ok) {
    const j = JSON.parse(r.out);
    return { release: j.isDraft ? "draft" : "published", releaseAssets: (j.assets ?? []).map((a) => a.name) };
  }
  if (/could not resolve to a repository/i.test(r.err)) return { release: "unknown", releaseAssets: [], why: `github.com/${REPO} does not exist, or this gh login cannot see it: create the public repository first` };
  if (/not found|could not find/i.test(r.err)) return { release: "absent", releaseAssets: [] };
  return { release: "unknown", releaseAssets: [], why: r.err.split("\n")[0] };
}

function npmState() {
  const r = run("npm", ["view", `${PKG}@${version}`, "version"]);
  if (r.ok) return r.out.split("\n").map((s) => s.trim().replace(/^'|'$/g, "")).includes(version);
  if (/E404|404/.test(r.err)) return false;
  return "unknown";
}

function cloneCheck(dir) {
  if (!dir) return { ok: false, why: "--public-clone <dir> is needed until the GitHub release exists (a clone of github.com/" + REPO + ")" };
  if (!existsSync(join(dir, ".git"))) return { ok: false, why: `${dir} is not a git clone` };
  const url = run("git", ["-C", dir, "remote", "get-url", "origin"]);
  const re = new RegExp(`github\\.com[:/]${BRAND.githubOrg}/${SLUG}(\\.git)?$`, "i");
  if (!url.ok || !re.test(url.out)) return { ok: false, why: `${dir}'s origin is ${url.out || "unset"}, not github.com/${REPO}` };
  if (run("git", ["-C", dir, "status", "--porcelain"]).out) return { ok: false, why: `${dir} has uncommitted changes` };
  return { ok: true };
}

function gather() {
  const head = run("git", ["rev-parse", "HEAD"]).out;
  const tagCommit = run("git", ["rev-parse", "-q", "--verify", `refs/tags/${TAG}^{commit}`]);
  const tag = !tagCommit.ok ? "absent" : tagCommit.out === head ? "head" : "elsewhere";
  const tagPushed = !!run("git", ["ls-remote", "--tags", "origin", `refs/tags/${TAG}`]).out;
  const rs = releaseState();
  const npmPublished = npmState();
  const local = opts.build ? { assets: releaseAssets({ slug: SLUG, version, apk: opts.apk ? releaseApkName(SLUG, version) : null }), missingLocal: [], byteProblems: [] } : readLocal();
  let remoteShaMatches = null;
  const shaName = `${SLUG}-${version}.tar.gz.sha256`;
  if (!opts.build && rs.releaseAssets.includes(shaName) && existsSync(out(shaName))) {
    const r = run("gh", ["release", "download", TAG, "--repo", REPO, "--pattern", shaName, "--output", "-"]);
    remoteShaMatches = r.ok ? r.out === readFileSync(out(shaName), "utf8").trim() : null;
  }
  const changelogText = existsSync(join(ROOT, "CHANGELOG.md")) ? readFileSync(join(ROOT, "CHANGELOG.md"), "utf8") : "";
  const facts = {
    version, pkg: PKG, yes: opts.yes, allowDirty: opts.allowDirty, build: opts.build, noApk: opts.noApk,
    branch: run("git", ["rev-parse", "--abbrev-ref", "HEAD"]).out,
    dirty: !!run("git", ["status", "--porcelain"]).out,
    headOnOriginMain: run("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"]).ok,
    head, tag, release: rs.release, npmPublished: npmPublished === true, remoteShaMatches,
    ...local,
    ghAuth: run("gh", ["auth", "status"]).ok,
    npmUser: run("npm", ["whoami"]).out || null,
    changelog: extractChangelogSection(changelogText, version),
  };
  // An unknown release state is refused below; the plan is shown as for a first publish.
  const planRelease = rs.release === "unknown" ? "absent" : rs.release;
  return { facts: { ...facts, release: planRelease, publicClone: planRelease === "absent" ? cloneCheck(opts.publicClone) : null }, state: { tag, tagPushed, release: planRelease, releaseAssets: rs.releaseAssets, npmPublished: npmPublished === true }, unknown: [rs.release === "unknown" && `could not tell whether ${TAG} is released: ${rs.why}`, npmPublished === "unknown" && `could not tell whether ${PKG}@${version} is on npm (npm view failed)`].filter(Boolean) };
}

const { facts, state, unknown } = gather();
const pf = preflight(facts);
for (const u of unknown) pf.checks.push({ name: "release state", ok: false, why: u });
const refused = pf.refused || unknown.length > 0;

console.log("\npreflight");
for (const c of pf.checks) console.log(`  ${c.waived ? "waived" : c.ok ? "ok    " : "REFUSE"} ${c.name}${c.why ? ` — ${c.why}` : ""}${c.waived ? " (--allow-dirty, dry run only)" : ""}`);

// ── plan ───────────────────────────────────────────────────────────────────
const notesFile = opts.yes ? join(mkdtempSync(join(tmpdir(), `${SLUG}-notes-`)), "notes.md") : `<tmp>/notes.md (CHANGELOG.md "## ${version}")`;
if (opts.yes && facts.changelog) writeFileSync(notesFile, facts.changelog + "\n");
const steps = planSteps(state, {
  slug: SLUG, name: BRAND.name, version, repo: REPO, pkg: PKG, assets: facts.assets, build: opts.build,
  buildArgs: opts.apk ? [`--apk=${opts.apk}`] : [], publicClone: opts.publicClone, accept: opts.accept, notesFile, dir: DIR,
  noApk: opts.noApk,
});

console.log("\nsteps");
for (const s of steps) {
  console.log(`  ${s.skip ? "skip" : s.refuse ? "STOP" : "run "} ${s.id}: ${s.title}${s.skip ? ` — already done: ${s.skip}` : s.refuse ? ` — ${s.refuse}` : ""}`);
  if (!s.skip) for (const c of s.cmds) console.log(`         $ ${shellLine(c)}`);
}
console.log("  then post-checks: download every asset back from the release URL and re-verify sha256 + signatures;");
console.log(`         npm view ${PKG}@${version} _hasShrinkwrap must be true; print install.sh's deploy step`);
console.log("  (no --provenance: npm provenance needs a CI OIDC identity — GitHub Actions — and this runs on a desktop)");

if (!opts.yes) {
  if (facts.changelog) console.log(`\nrelease notes (CHANGELOG.md "## ${version}"):\n${facts.changelog.split("\n").map((l) => `  | ${l}`).join("\n")}`);
  console.log(`\ndry run: nothing was changed.${refused ? " Fix every REFUSE above first." : ""} To publish:\n  npm run release:publish -- --yes${opts.build ? " --build" : ""}${opts.noApk ? " --no-apk" : ""}${opts.publicClone ? ` --public-clone ${opts.publicClone}` : ""}`);
  process.exit(refused ? 1 : 0);
}
if (refused) die("refused: fix every REFUSE above. Nothing was changed.", 1);

// ── run ────────────────────────────────────────────────────────────────────
const resumeHint = `re-run \`npm run release:publish -- --yes${opts.publicClone ? ` --public-clone ${opts.publicClone}` : ""}${opts.noApk ? " --no-apk" : ""}\` to resume from here (done steps are skipped)`;
for (const s of steps) {
  if (s.skip) { console.log(`\n== ${s.id}: skipped, already done (${s.skip})`); continue; }
  if (s.refuse) die(`step ${s.id} refused: ${s.refuse}. ${resumeHint}.`, 1);
  console.log(`\n== ${s.id}: ${s.title}`);
  for (const c of s.cmds) {
    console.log(`$ ${shellLine(c)}`);
    const r = spawnSync(c[0], c.slice(1), { cwd: ROOT, stdio: "inherit" });
    if (r.status !== 0) die(`step ${s.id} failed (${shellLine(c)} exited ${r.status ?? r.error?.message}). ${resumeHint}.`, 1);
  }
  if (s.id === "build") {
    // The build made the bytes: check them as the preflight would have.
    const local = readLocal();
    const again = preflight({ ...facts, build: false, ...local, releaseCommit: local.releaseCommit });
    const bad = again.checks.filter((c) => !c.ok);
    if (bad.length) die(`the fresh build fails its checks: ${bad.map((c) => `${c.name} — ${c.why}`).join("; ")}`, 1);
    facts.assets = local.assets;
  }
}

// ── post-checks ────────────────────────────────────────────────────────────
console.log("\n== post-checks");
let failed = 0;
const base = `https://github.com/${REPO}/releases/download/${TAG}/`;
const got = {};
for (const a of facts.assets.filter((x) => x.github)) {
  try {
    const res = await fetch(base + a.name, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    got[a.name] = Buffer.from(await res.arrayBuffer());
    const same = sha256Hex(got[a.name]) === sha256Hex(readFileSync(out(a.name)));
    console.log(`  ${same ? "ok  " : "FAIL"} ${a.name}${same ? "" : " — the downloaded bytes differ from dist-release/"}`);
    if (!same) failed++;
  } catch (e) { console.log(`  FAIL ${a.name} — ${base + a.name}: ${e.message}`); failed++; }
}
const problems = verifyReleaseBytes(got, loadPublicKey(readFileSync(join(ROOT, PUBKEY_PATH), "utf8")), { slug: SLUG, version });
for (const p of problems) { console.log(`  FAIL downloaded: ${p}`); failed++; }
if (!problems.length) console.log("  ok   downloaded .sha256 matches the tarball; both signatures verify against deploy/release-pubkey.pem");

const sw = readHasShrinkwrap(run("npm", ["view", `${PKG}@${version}`, "_hasShrinkwrap"]).out);
if (sw === true) console.log(`  ok   npm ${PKG}@${version} has npm-shrinkwrap.json`);
else {
  failed++;
  console.log([
    "",
    "  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
    `  !! npm ${PKG}@${version}: _hasShrinkwrap is ${sw === null ? "unreadable" : "not true"}.`,
    "  !! `npm i -g` will resolve every transitive dependency afresh instead of the versions",
    "  !! package-lock.json tested — the npm route installs an untested tree. A published version",
    "  !! cannot be replaced: fix the build, bump the version, publish again (and deprecate this one:",
    `  !!   npm deprecate ${PKG}@${version} "missing shrinkwrap, use the next version").`,
    "  !! (Right after publishing the registry can lag a minute: re-check with",
    `  !!   npm view ${PKG}@${version} _hasShrinkwrap   before acting on this.)`,
    "  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
  ].join("\n"));
}

const installUrl = `https://${BRAND.domain}/install.sh`;
console.log(`
== install.sh: one step by hand
  ${DIR}/install.sh is rendered and attached to the release, but ${installUrl} is not deployed by
  anything in this repo. Put ${DIR}/install.sh at ${installUrl} (or make that URL redirect to
  https://github.com/${REPO}/releases/latest/download/install.sh), then check it:
    curl -fsSL ${installUrl} | cmp - ${DIR}/install.sh && echo same`);

if (failed) die(`${failed} post-check(s) failed: the release is out, read each FAIL above.`, 1);
console.log(`\n${BRAND.name} ${version} is published.`);
