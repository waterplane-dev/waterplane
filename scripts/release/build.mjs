#!/usr/bin/env node
// Build the release artifacts into `dist-release/`. Layout and why: docs/notes/distribution.md.
//
//   node scripts/release/build.mjs [--no-build] [--allow-dirty] [--unsigned] [--apk=<file.apk>]
//
//   <slug>-<version>.tar.gz          the platform-independent runtime tree (primary route)
//   <slug>-<version>.tar.gz.sha256   sha256sum format
//   <slug>-<version>.tar.gz.sha256.sig  Ed25519 signature of the .sha256's exact bytes (base64);
//                                    the installer refuses a release without a valid one
//   release.json                     a copy of the one inside the tarball; `builtins` = the
//                                    in-repo extensions shipped and their default switch,
//                                    decided by deploy/ship.json for the optional ones
//   release.json.sig                 its signature, the same way
//   <slug>-<version>.tgz             `npm pack` of the same tree, deps declared (secondary route)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// The brand (and with it the slug, the env spelling and the manifest name) is read off
// `packages/shared/dist`, which a fresh `npm ci` does not have: build it BEFORE the first import
// that needs it, or a clean clone dies with ERR_MODULE_NOT_FOUND before saying anything.
if (!existsSync(join(ROOT, "packages/shared/dist/brand.js"))) execFileSync("npm", ["run", "build:shared"], { cwd: ROOT, stdio: "inherit" });
const { E, SLUG } = await import("../lib-brand.mjs");
const { verifyDevApk } = await import("./apk-lib.mjs");
const { buildShrinkwrap } = await import("./shrinkwrap-lib.mjs");
const { PUBKEY_PATH, assertKeyMatches, defaultKeyPath, loadPrivateKey, signFile } = await import("./sign-lib.mjs");
const OUT = join(ROOT, "dist-release");
const args = new Set(process.argv.slice(2));
for (const a of args) if (!["--no-build", "--allow-dirty", "--unsigned"].includes(a) && !a.startsWith("--apk=")) { console.error(`unknown flag ${a}`); process.exit(2); }

const sh = (cmd, a, opts = {}) => execFileSync(cmd, a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts }).trim();
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

// ── preconditions ──────────────────────────────────────────────────────────
const dirty = sh("git", ["status", "--porcelain"]);
if (dirty && !args.has("--allow-dirty")) {
  console.error("release: the working tree is dirty (the commit is recorded in release.json). Commit, or pass --allow-dirty.\n" + dirty);
  process.exit(1);
}
// The signing key, checked BEFORE the build so a missing or wrong key costs nothing. `--unsigned`
// is for dev builds only: the installer refuses them unless told to skip the check. The key is
// read here and never printed; a failure names the path, not the contents.
const unsigned = args.has("--unsigned");
let signingKey = null;
if (!unsigned) {
  const keyPath = process.env[E.RELEASE_KEY] || defaultKeyPath(SLUG);
  if (!existsSync(keyPath)) {
    console.error(`release: no signing key at ${keyPath} (set ${E.RELEASE_KEY}, or make one with node scripts/release/keygen.mjs). Pass --unsigned for a dev build the installer will refuse.`);
    process.exit(1);
  }
  try {
    signingKey = loadPrivateKey(readFileSync(keyPath, "utf8"));
    assertKeyMatches(signingKey, readFileSync(join(ROOT, PUBKEY_PATH), "utf8"));
  } catch (e) { console.error(`release: ${keyPath}: ${e.message}. Nothing was built.`); process.exit(1); }
}
if (!args.has("--no-build")) execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
for (const p of ["packages/shared/dist", "packages/host/dist/cli/index.js", "packages/web/dist"]) {
  if (!existsSync(join(ROOT, p))) { console.error(`release: ${p} is missing — build first (omit --no-build).`); process.exit(1); }
}

const rootPkg = readJson("package.json");
const hostPkg = readJson("packages/host/package.json");
const sharedPkg = readJson("packages/shared/package.json");
const lock = readJson("package-lock.json");
const version = rootPkg.version;
const nodeVersion = readFileSync(join(ROOT, "deploy/node-version"), "utf8").trim();
const commit = sh("git", ["rev-parse", "HEAD"]) + (dirty ? "-dirty" : "");
const { PROTOCOL_VERSION } = await import(join(ROOT, "packages/shared/dist/index.js"));
const { BRAND } = await import(join(ROOT, "packages/shared/dist/brand.js"));
const { devApplicationId, releaseApkName } = await import(join(ROOT, "packages/shared/dist/brand.js"));
const BRAND_MANIFEST = BRAND.pluginManifest;
const builtins = shipBuiltins(readJson("deploy/ship.json"));
const releaseJson = { name: SLUG, version, commit, builtAt: new Date().toISOString(), node: nodeVersion, protocolVersion: PROTOCOL_VERSION, builtins };
// --apk=<file>: the sideloadable Android build, copied beside the tarball as <slug>-<version>.apk and
// named in release.json as `apk`. Upload it as a release asset: the pairing page links
// releases/download/v<version>/<apk> ONLY when release.json names it (pair.ts releaseApkUrl).
const apkArg = [...args].find((a) => a.startsWith("--apk="))?.slice(6);
if (apkArg) {
  if (!existsSync(apkArg) || !/\.apk$/i.test(apkArg)) { console.error(`release: --apk ${apkArg} is not an .apk file.`); process.exit(1); }
  // Only the dev flavor is a sideload asset; read its applicationId and refuse anything else (apk-lib.mjs).
  try { const r = verifyDevApk(apkArg, devApplicationId(BRAND.appId), BRAND.appId); console.log(`release: --apk applicationId ${r.id} (read via ${r.via})`); }
  catch (e) { console.error(`release: --apk ${apkArg}: ${e.message}`); process.exit(1); }
  releaseJson.apk = releaseApkName(SLUG, version);
}

/**
 * Which in-repo extensions this release carries, and each one's default switch — the host reads it
 * back from `release.json` (`packages/host/src/plugins/builtin.ts`). An extension is OPTIONAL when
 * its manifest says so, and then `deploy/ship.json` must name it: `{ ship, on, experimental }` — or,
 * for an extension the public snapshot leaves out, its OWN `packages/extensions/<id>/ship.json` (the
 * same three fields), so the decision travels with the folder and the public file names nothing it
 * does not carry; `deploy/ship.json` wins where both speak. A missing entry, or an `experimental`
 * that disagrees with the manifest, stops the build in words — shipping (or labelling) one by
 * omission is the failure this file exists to prevent. Every other extension always ships, on. An id
 * `ship.json` names that this tree does not have is not shipped.
 */
function shipBuiltins(ship) {
  const decided = ship?.builtins ?? {};
  const out = {};
  const extDir = join(ROOT, "packages/extensions");
  for (const id of existsSync(extDir) ? readdirSync(extDir).sort() : []) {
    const mf = join(extDir, id, BRAND_MANIFEST);
    if (!existsSync(mf)) continue;
    const m = JSON.parse(readFileSync(mf, "utf8"));
    if (m.optional !== true) { out[id] = { on: true }; continue; }
    const own = join(extDir, id, "ship.json");
    const d = decided[id] ?? (existsSync(own) ? JSON.parse(readFileSync(own, "utf8")) : undefined);
    if (!d || typeof d.ship !== "boolean") { console.error(`release: packages/extensions/${id} is optional, and neither deploy/ship.json nor packages/extensions/${id}/ship.json says whether it ships ({ "builtins": { "${id}": { "ship": true|false, "on": true|false } } }).`); process.exit(1); }
    if ((d.experimental === true) !== (m.experimental === true)) { console.error(`release: deploy/ship.json says ${id} is ${d.experimental ? "" : "not "}experimental; its manifest says the opposite. Make them agree.`); process.exit(1); }
    if (d.ship) out[id] = { on: d.on !== false, ...(m.experimental ? { experimental: true } : {}) };
  }
  // A name with no folder is an extension this TREE does not carry — the public snapshot leaves the
  // private ones out (`deploy/public-allowlist.txt`) while `ship.json` still names them. Not shipped,
  // said once; a misspelt id reads the same way, which is why the sentence names it.
  for (const id of Object.keys(decided)) if (!existsSync(join(extDir, id, BRAND_MANIFEST))) console.error(`release: deploy/ship.json names "${id}", which is not under packages/extensions/ in this tree — it does not ship.`);
  return out;
}
const dirName = `${SLUG}-${version}`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// ── copying helpers ────────────────────────────────────────────────────────
const SKIP = (src) => !/\.tsbuildinfo$|\.test\.(m?js|d\.ts)$|(^|\/)\.DS_Store$/.test(src);
function copy(from, to) {
  if (!existsSync(join(ROOT, from))) return false;
  cpSync(join(ROOT, from), join(to.base, to.rel ?? from), { recursive: true, filter: SKIP, dereference: false });
  return true;
}

/** The files every layout carries: the sources, the compiled tree, the docs. */
function stageTree(dir, { sharedAtPackages }) {
  const t = { base: dir };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "release.json"), JSON.stringify(releaseJson, null, 2) + "\n");
  mkdirSync(join(dir, "bin"));
  // Generated, so the slug is filled in from the brand rather than spelled here.
  const shim = join(dir, "bin", `${SLUG}.mjs`);
  writeFileSync(shim, [
    "#!/usr/bin/env node",
    'import { main } from "../packages/host/dist/cli/index.js";',
    "const code = await main(process.argv.slice(2));",
    // let a piped stdout drain before exiting
    'await new Promise((r) => process.stdout.write("", r));',
    "process.exit(code);",
    "",
  ].join("\n"));
  chmodSync(shim, 0o755);
  if (sharedAtPackages) {
    copy("packages/shared/package.json", t);
    copy("packages/shared/dist", t);
  }
  copy("packages/host/package.json", t);
  copy("packages/host/dist", t);
  copy("packages/web/dist", t);
  // Built-in extensions: the host reads each one's manifest from the SOURCE folder
  // (plugins/builtin.ts); the compiled code is in host/dist/extensions. Only the ones
  // this release ships (`builtins`, from deploy/ship.json); a dropped one leaves no
  // compiled code behind either, and `release.json` does not name it.
  const extDir = join(ROOT, "packages/extensions");
  for (const id of existsSync(extDir) ? readdirSync(extDir) : []) {
    if (builtins[id]) copy(`packages/extensions/${id}/${BRAND_MANIFEST}`, t);
    else rmSync(join(dir, "packages/host/dist/extensions", id), { recursive: true, force: true });
  }
  // repohealth's engine is resolved at <root>/tools/repohealth.mjs (repohealth.ts).
  copy("tools/repohealth.mjs", t);
  copy("tools/repohealth", t);
  for (const f of ["LICENSE", "README.md", "SECURITY.md", "NOTICES.md", "DISCLAIMER.md", "CHANGELOG.md"]) copy(f, t);
}

// ── 1. the runtime tarball ─────────────────────────────────────────────────
const stage = join(OUT, "stage", dirName);
stageTree(stage, { sharedAtPackages: true });
writeFileSync(join(stage, "package.json"), JSON.stringify({
  name: SLUG, version, type: "module", description: rootPkg.description, license: rootPkg.license,
  bin: { [SLUG]: `bin/${SLUG}.mjs` }, engines: { node: rootPkg.engines.node },
}, null, 2) + "\n");

// Production deps only, exactly as the lockfile resolved them: npm lists the
// installed prod tree; each package is copied whole (all node-pty prebuilds kept).
const listed = sh("npm", ["ls", "-w", hostPkg.name, "--omit=dev", "--all", "--parseable"], { maxBuffer: 64 << 20 }).split("\n").filter(Boolean);
const nm = join(ROOT, "node_modules");
const prod = new Set();
for (const p of listed) {
  // From the FIRST node_modules/ on, not relative(nm, p): npm masks a uuid-shaped path
  // segment as `***` in its output, so a checkout under such a directory (a scratch or CI
  // dir) listed nothing and shipped a tarball without `ws` or `node-pty`.
  const at = p.indexOf("/node_modules/");
  if (at < 0) continue;                             // the root
  const rel = p.slice(at + "/node_modules/".length);
  if (rel.startsWith("@waterplane")) continue;      // the workspaces: copied below, as real directories
  prod.add(rel);
}
for (const rel of prod) cpSync(join(nm, rel), join(stage, "node_modules", rel), { recursive: true, dereference: false });
// @waterplane/shared as a REAL copy (the checkout's node_modules entry is a symlink).
const sharedDest = join(stage, "node_modules", "@waterplane", "shared");
mkdirSync(sharedDest, { recursive: true });
cpSync(join(ROOT, "packages/shared/package.json"), join(sharedDest, "package.json"));
cpSync(join(ROOT, "packages/shared/dist"), join(sharedDest, "dist"), { recursive: true, filter: SKIP });

const tarball = join(OUT, `${dirName}.tar.gz`);
// COPYFILE_DISABLE keeps macOS from adding AppleDouble `._*` entries.
// --no-mac-metadata (bsdtar): no LIBARCHIVE.xattr headers, which GNU tar warns about per file on Linux.
execFileSync("tar", [...(process.platform === "darwin" ? ["--no-mac-metadata"] : []), "--uid", "0", "--gid", "0", "-czf", tarball, "-C", join(OUT, "stage"), dirName], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
const sha = createHash("sha256").update(readFileSync(tarball)).digest("hex");
writeFileSync(`${tarball}.sha256`, `${sha}  ${dirName}.tar.gz\n`);
writeFileSync(join(OUT, "release.json"), JSON.stringify(releaseJson, null, 2) + "\n");
// Sign the bytes the installer trusts: the .sha256 binds the tarball; release.json is what
// `update --check` reads off the release page.
const signed = signingKey ? [signFile(signingKey, `${tarball}.sha256`), signFile(signingKey, join(OUT, "release.json"))] : [];
if (apkArg) copyFileSync(apkArg, join(OUT, releaseJson.apk));

// ── 2. the npm tarball ─────────────────────────────────────────────────────
// Same tree minus node_modules: runtime deps are declared (versions from the
// lockfile), and @waterplane/shared is BUNDLED so `npm i -g` needs no registry
// entry for it.
const npmStage = join(OUT, "stage-npm", dirName);
stageTree(npmStage, { sharedAtPackages: false });
const locked = (name) => lock.packages?.[`node_modules/${name}`]?.version;
const deps = {};
for (const name of Object.keys(hostPkg.dependencies)) {
  if (name === sharedPkg.name) continue;
  const v = locked(name);
  if (!v) { console.error(`release: ${name} is not in package-lock.json`); process.exit(1); }
  deps[name] = v;
}
deps[sharedPkg.name] = sharedPkg.version;
const npmPkg = {
  name: SLUG, version, type: "module", description: rootPkg.description, license: rootPkg.license,
  author: rootPkg.author, keywords: rootPkg.keywords,
  bin: { [SLUG]: `bin/${SLUG}.mjs` }, engines: { node: rootPkg.engines.node },
  dependencies: deps, bundleDependencies: [sharedPkg.name],
};
writeFileSync(join(npmStage, "package.json"), JSON.stringify(npmPkg, null, 2) + "\n");
// npm-shrinkwrap.json pins the TRANSITIVE versions to the ones package-lock.json resolved (npm honours it on
// `npm i -g`). Derived from the lockfile, never re-resolved; @waterplane/shared is bundled (shrinkwrap-lib.mjs).
writeFileSync(join(npmStage, "npm-shrinkwrap.json"), JSON.stringify(
  buildShrinkwrap(lock, npmPkg, { [sharedPkg.name]: { version: sharedPkg.version } }), null, 2) + "\n");
const npmShared = join(npmStage, "node_modules", "@waterplane", "shared");
mkdirSync(npmShared, { recursive: true });
cpSync(join(ROOT, "packages/shared/package.json"), join(npmShared, "package.json"));
cpSync(join(ROOT, "packages/shared/dist"), join(npmShared, "dist"), { recursive: true, filter: SKIP });
// The host's own package.json declares workspace-only deps; it is never installed from here.
const out = execFileSync("npm", ["pack", "--pack-destination", OUT, "--json"], { cwd: npmStage, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const npmFile = JSON.parse(out)[0].filename;

rmSync(join(OUT, "stage"), { recursive: true, force: true });
rmSync(join(OUT, "stage-npm"), { recursive: true, force: true });

const mb = (f) => `${(statSync(join(OUT, f)).size / 1048576).toFixed(1)} MB`;
console.log(`release ${SLUG} ${version} @ ${commit.slice(0, 10)} (node ${nodeVersion}) -> ${relative(ROOT, OUT)}/`);
if (unsigned) console.log(`  UNSIGNED (--unsigned): the installer refuses this release unless run with ${E.INSECURE_SKIP_SIG}=1`);
for (const f of [`${dirName}.tar.gz`, `${dirName}.tar.gz.sha256`, ...signed.map((p) => relative(OUT, p)), "release.json", npmFile, ...(apkArg ? [releaseJson.apk] : [])]) console.log(`  ${f}  ${mb(f)}`);
