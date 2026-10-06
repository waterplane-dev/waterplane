// Pure parts of `publish.mjs`: what a release consists of, whether it may go out, and which steps
// a (re-)run still has to do. No process, no network, no file reads: the caller gathers the facts
// and runs the commands; everything here is decided from values, so it is tested in isolation
// (publish-lib.test.mjs). Why the release looks like this: docs/notes/distribution.md.
import { createHash } from "node:crypto";
import { verifyBytes } from "./sign-lib.mjs";

export { extractChangelogSection } from "./public-lib.mjs";

/** The git tag (private repo AND public repo) of a version. */
export const tagOf = (version) => `v${String(version).replace(/^v/, "")}`;

/** `npm pack`'s file name for an unscoped package. */
export const npmTarballName = (slug, version) => `${slug}-${version}.tgz`;

/**
 * Every file of a release, by role. `github` = uploaded as a GitHub release asset (the installer
 * and `update` fetch them from `releases/download/v<v>/`); `local` = must exist in dist-release
 * before anything goes out. The APK is there only when release.json names one (`apk`); install.sh
 * is rendered by this run, so it is uploaded but not required up front.
 */
export function releaseAssets({ slug, version, apk = null }) {
  const tar = `${slug}-${version}.tar.gz`;
  const list = [
    { name: tar, github: true, local: true, role: "tarball" },
    { name: `${tar}.sha256`, github: true, local: true, role: "sha256" },
    { name: `${tar}.sha256.sig`, github: true, local: true, role: "sha256-sig" },
    { name: "release.json", github: true, local: true, role: "release-json" },
    { name: "release.json.sig", github: true, local: true, role: "release-json-sig" },
    ...(apk ? [{ name: apk, github: true, local: true, role: "apk" }] : []),
    { name: "install.sh", github: true, local: false, role: "installer" },
    { name: npmTarballName(slug, version), github: false, local: true, role: "npm" },
  ];
  return list;
}

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Check a release's bytes against each other and the committed public key — the same rules the
 * installer applies. `files` maps asset name → Buffer (from dist-release, or downloaded back from
 * the release page). Returns sentences, one per problem; empty = good.
 */
export function verifyReleaseBytes(files, publicKey, { slug, version }) {
  const tar = `${slug}-${version}.tar.gz`;
  const problems = [];
  const need = (n) => { if (!files[n]) { problems.push(`${n} is missing`); return false; } return true; };
  if (need(`${tar}.sha256`) && need(tar)) {
    const line = files[`${tar}.sha256`].toString("utf8").trim();
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line);
    if (!m) problems.push(`${tar}.sha256 is not one "<hex>  <file>" line`);
    else {
      if (m[2] !== tar) problems.push(`${tar}.sha256 names ${m[2]}, not ${tar}`);
      if (m[1] !== sha256Hex(files[tar])) problems.push(`${tar}.sha256 does not match the tarball's bytes`);
    }
  }
  for (const n of [`${tar}.sha256`, "release.json"]) {
    if (!files[n] || !need(`${n}.sig`)) continue;
    if (!verifyBytes(publicKey, files[n], files[`${n}.sig`].toString("utf8"))) problems.push(`${n}.sig does not verify against deploy/release-pubkey.pem`);
  }
  if (files["release.json"]) {
    let rj = null;
    try { rj = JSON.parse(files["release.json"].toString("utf8")); } catch { problems.push("release.json is not JSON"); }
    if (rj && rj.version !== version) problems.push(`release.json says version ${rj.version}, package.json says ${version}`);
    if (rj && rj.name !== slug) problems.push(`release.json says name ${rj.name}, not ${slug}`);
  }
  return problems;
}

/**
 * The preflight: every check with a verdict, never stopping at the first (the person fixes them
 * all in one go). `facts` is what publish.mjs gathered; a missing fact (undefined) means "not
 * checked", which is itself a refusal for the checks that guard the outside world.
 *
 * facts: {
 *   version, yes, allowDirty, build,
 *   branch, dirty, headOnOriginMain,
 *   tag: "absent" | "head" | "elsewhere",
 *   release: "absent" | "draft" | "published", npmPublished: bool,
 *   remoteShaMatches: bool | null   (release exists with a .sha256: same build as dist-release?)
 *   missingLocal: string[], byteProblems: string[], releaseCommit, head,
 *   npmHasShrinkwrap: bool, ghAuth: bool, npmUser: string|null, changelog: string|null,
 *   publicClone: { given, ok, why } | null,
 *   assets: releaseAssets() (an APK there = release.json names one), noApk: bool (--no-apk)
 * }
 * Returns { checks: [{ name, ok, why }], refused: bool }.
 */
export function preflight(f) {
  const checks = [];
  const add = (name, ok, why = "") => checks.push({ name, ok: !!ok, why: ok ? "" : why });
  const waive = f.allowDirty && !f.yes;
  // A check --allow-dirty waives still says it failed: "waived", with the reason, never a bare ok.
  const soft = (name, ok, why) => checks.push(ok ? { name, ok: true, why: "" } : { name, ok: waive, waived: waive, why });
  const v = f.version;
  const tag = tagOf(v);

  if (f.allowDirty && f.yes) add("--allow-dirty", false, "--allow-dirty is for a dry run only; a real publish needs a clean tree on main");
  soft("on main", f.branch === "main", `on branch ${f.branch}, not main`);
  soft("clean tree", !f.dirty, "the working tree has uncommitted changes");
  soft("HEAD is on origin/main", f.headOnOriginMain, "HEAD is not on origin/main: push it first, a release must be a commit others can see");

  const resuming = f.release !== "absent";
  if (f.tag === "elsewhere") add(`tag ${tag}`, false, `${tag} already exists on another commit: this version was released before, bump package.json's version`);
  else add(`tag ${tag}`, true);

  if (f.npmPublished && !resuming) add("not on npm yet", false, `${f.pkg ?? "the package"}@${v} is already on npm but there is no GitHub release ${tag}: a version is published once, bump package.json's version`);
  if (resuming && f.build) add("--build on a resumed release", false, `the GitHub release ${tag} exists: rebuilding would make different bytes than it carries. Re-run without --build`);
  if (resuming && f.remoteShaMatches === false) add("same build as the release", false, `the GitHub release ${tag} carries a different .sha256 than dist-release/: this dist-release is not the build that was released`);

  if (!f.build) {
    add("assets in dist-release/", !f.missingLocal?.length, `missing: ${(f.missingLocal ?? []).join(", ")} (npm run release:build)`);
    add("signatures and .sha256", !f.byteProblems?.length, (f.byteProblems ?? []).join("; "));
    if (f.releaseCommit !== f.head && String(f.releaseCommit ?? "").replace(/-dirty$/, "") === f.head) soft("release.json is this commit", false, `release.json was built from a dirty tree (${f.releaseCommit})`);
    else add("release.json is this commit", f.releaseCommit === f.head, `release.json was built from ${f.releaseCommit ?? "?"}, HEAD is ${f.head}: rebuild (npm run release:build)`);
    add("npm tarball carries npm-shrinkwrap.json", f.npmHasShrinkwrap, "the npm .tgz has no npm-shrinkwrap.json: `npm i -g` would re-resolve every transitive dependency");
  }
  // Undrafting makes the release releases/latest, which the pair page and the docs send a phone
  // to for the Android app: a release without one goes out only when --no-apk says so on purpose.
  if (f.release !== "published") {
    const hasApk = (f.assets ?? []).some((a) => a.role === "apk");
    if (f.noApk && hasApk) add("--no-apk", false, "--no-apk was passed but dist-release/release.json names an APK: drop one or the other");
    else if (!f.noApk) add("APK asset", hasApk, "the release would be undrafted without an Android APK: build with --build --apk=<file.apk> (release.json then names it), or pass --no-apk to publish without one on purpose");
  }
  add("CHANGELOG.md entry", !!f.changelog, `CHANGELOG.md has no "## ${v}" section: write one (it becomes the release notes) — "Unreleased" does not count`);
  add("gh auth status", f.ghAuth, "gh is not logged in (gh auth login)");
  add("npm whoami", !!f.npmUser, "npm is not logged in (npm login)");
  if (f.publicClone) add("public clone", f.publicClone.ok, f.publicClone.why);
  return { checks, refused: checks.some((c) => !c.ok) };
}

/**
 * The steps of a publish and which of them a re-run skips. Each step: { id, title, cmds: string[][]
 * (argv), skip: string|null (why it is already done), refuse?: string (why it must not run) }. The order is the order they run in; a
 * failure stops the run, and the next run starts at the first step not yet done.
 *
 * state: { tag: "absent"|"head", tagPushed, release: "absent"|"draft"|"published",
 *          releaseAssets: string[] (names already on the release), npmPublished }
 * ctx:   { slug, name, version, repo ("<org>/<slug>"), pkg, assets (releaseAssets()), build,
 *          buildArgs: string[], publicClone, accept, notesFile, dir ("dist-release"),
 *          noApk (--no-apk: undraft without an APK asset, on purpose) }
 */
export function planSteps(state, ctx) {
  const tag = tagOf(ctx.version);
  const at = (n) => `${ctx.dir}/${n}`;
  const gh = ctx.assets.filter((a) => a.github).map((a) => a.name);
  const released = state.release !== "absent";
  const steps = [];
  if (ctx.build) steps.push({ id: "build", title: "build dist-release/", cmds: [["npm", "run", "release:build", ...(ctx.buildArgs?.length ? ["--", ...ctx.buildArgs] : [])]], skip: null });
  // Proof that the snapshot stands on its own (a real `npm ci`, build, lint, tests) BEFORE anything
  // leaves this desktop: the tag push below is the first outward write. A failure stops the run.
  steps.push({
    id: "verify", title: "verify the public snapshot installs, builds, lints and passes on its own",
    cmds: [["node", "scripts/verify-public-tree.mjs", "--rev", "HEAD"]],
    skip: released ? `the GitHub release ${tag} exists, so its snapshot was verified and pushed` : null,
  });
  steps.push({
    id: "tag", title: `tag ${tag} in this repo and push the tag`,
    cmds: [
      ...(state.tag === "head" ? [] : [["git", "tag", "-a", tag, "-m", `${ctx.name} ${ctx.version}`]]),
      ...(state.tagPushed ? [] : [["git", "push", "origin", `refs/tags/${tag}`]]),
    ],
    skip: state.tag === "head" && state.tagPushed ? `${tag} exists on HEAD and on origin` : null,
  });
  steps.push({
    id: "public", title: "commit the public snapshot and push it",
    cmds: [
      ["node", "scripts/release/publish-public.mjs", "--tag", tag, "--to", ctx.publicClone ?? "<public-clone>", "--commit", ...(ctx.accept ? ["--accept", ctx.accept] : [])],
      ["git", "-C", ctx.publicClone ?? "<public-clone>", "push", "origin", "main"],
    ],
    skip: released ? `the GitHub release ${tag} exists, so its snapshot was pushed` : null,
  });
  steps.push({ id: "install-sh", title: "render install.sh", cmds: [["npm", "run", "release:install-sh"]], skip: null });
  const title = `${ctx.name} ${ctx.version}`;
  steps.push({
    id: "release", title: `create the GitHub release ${tag} as a draft with its assets`,
    cmds: [["gh", "release", "create", tag, "--repo", ctx.repo, "--target", "main", "--draft", "--title", title, "--notes-file", ctx.notesFile, ...gh.map(at)]],
    skip: released ? `the GitHub release ${tag} exists (${state.release})` : null,
  });
  const missing = released ? gh.filter((n) => !(state.releaseAssets ?? []).includes(n)) : [];
  // A published release with missing assets is still completed: the installer refuses a release
  // without its .sig, so the gap is worse than the upload.
  if (released) steps.push({
    id: "upload", title: "upload the assets the release is missing",
    cmds: missing.length ? [["gh", "release", "upload", tag, "--repo", ctx.repo, ...missing.map(at)]] : [],
    skip: missing.length ? null : "every asset is on the release",
  });
  // The preflight refuses this too; the step says it again so the plan itself never undrafts an
  // APK-less release by accident (the runner stops at a step with a `refuse`).
  const noApkAsset = !ctx.assets.some((a) => a.role === "apk") && !ctx.noApk;
  steps.push({
    id: "undraft", title: `publish the release (it becomes releases/latest)`,
    cmds: [["gh", "release", "edit", tag, "--repo", ctx.repo, "--draft=false", "--latest"]],
    skip: state.release === "published" ? "the release is already published" : null,
    ...(noApkAsset && state.release !== "published" ? { refuse: "no APK asset: undrafting needs one, or --no-apk on purpose" } : {}),
  });
  steps.push({
    id: "npm", title: `npm publish ${ctx.pkg}@${ctx.version}`,
    cmds: [["npm", "publish", at(npmTarballName(ctx.slug, ctx.version)), "--access", "public"]],
    skip: state.npmPublished ? `${ctx.pkg}@${ctx.version} is already on npm` : null,
  });
  return steps;
}

/** A command as one line a person can paste: arguments with shell-special characters quoted. */
export const shellLine = (argv) => argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`)).join(" ");

/** What `npm view <pkg>@<v> _hasShrinkwrap` printed, read as a verdict: true, false, or null (unknown). */
export function readHasShrinkwrap(stdout) {
  const s = String(stdout ?? "").trim();
  if (s === "true") return true;
  if (s === "" || s === "false" || s === "undefined") return false;
  return null;
}
