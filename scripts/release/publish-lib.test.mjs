// node --test: the pure decisions behind `npm run release:publish` (publish-lib.mjs) — what a
// release consists of, the preflight's refusals, the CHANGELOG notes, the byte checks the installer
// would also make, and the resume plan that keeps a re-run from publishing anything twice.
// Throwaway keys only; nothing here touches git, gh, npm or the network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NPM_WAIT_SECONDS, NPM_WORKFLOW, extractChangelogSection, npmTarballName, npmWaitDecision, planSteps, preflight, readHasShrinkwrap, readNpmHasVersion,
  readProvenance, readWorkflowRun, releaseAssets, sha256Hex, shellLine, tagOf, verifyReleaseBytes,
} from "./publish-lib.mjs";
import { generateKeys, loadPrivateKey, loadPublicKey, signBytes } from "./sign-lib.mjs";

const SLUG = "waterplane", V = "1.2.3";

test("the asset list: GitHub gets tarball, .sha256, both .sig, release.json, install.sh; the APK only when named; npm .tgz stays local", () => {
  const a = releaseAssets({ slug: SLUG, version: V });
  assert.deepEqual(a.filter((x) => x.github).map((x) => x.name), [
    "waterplane-1.2.3.tar.gz", "waterplane-1.2.3.tar.gz.sha256", "waterplane-1.2.3.tar.gz.sha256.sig",
    "release.json", "release.json.sig", "install.sh",
  ]);
  assert.deepEqual(a.filter((x) => !x.github).map((x) => x.name), ["waterplane-1.2.3.tgz"]);
  assert.equal(a.find((x) => x.name === "install.sh").local, false, "rendered by the run, not required up front");
  const withApk = releaseAssets({ slug: SLUG, version: V, apk: "waterplane-1.2.3.apk" });
  assert.ok(withApk.some((x) => x.name === "waterplane-1.2.3.apk" && x.github && x.local));
  assert.equal(npmTarballName(SLUG, V), "waterplane-1.2.3.tgz");
  assert.equal(tagOf("v1.2.3"), "v1.2.3");
  assert.equal(tagOf(V), "v1.2.3");
});

test("CHANGELOG: the version's section is the notes; Unreleased is not a version", () => {
  const md = "# Changelog\n\n## Unreleased\n\n- next\n\n## 1.2.3 — 2026-10-04\n\n- shipped a thing\n\n## 1.2.2\n\n- older\n";
  assert.equal(extractChangelogSection(md, V), "- shipped a thing");
  assert.equal(extractChangelogSection(md, "v1.2.2"), "- older");
  assert.equal(extractChangelogSection(md, "1.2.4"), null);
  assert.equal(extractChangelogSection("## 1.2.30\n\n- not this\n", V), null, "1.2.3 is not a prefix match of 1.2.30");
});

/** A self-consistent release, signed with a throwaway key. */
function fixture() {
  const k = generateKeys();
  const priv = loadPrivateKey(k.privatePem);
  const tar = Buffer.from("not really a tarball");
  const sha = Buffer.from(`${sha256Hex(tar)}  ${SLUG}-${V}.tar.gz\n`);
  const rj = Buffer.from(JSON.stringify({ name: SLUG, version: V, commit: "abc" }) + "\n");
  const files = {
    [`${SLUG}-${V}.tar.gz`]: tar, [`${SLUG}-${V}.tar.gz.sha256`]: sha, [`${SLUG}-${V}.tar.gz.sha256.sig`]: Buffer.from(signBytes(priv, sha) + "\n"),
    "release.json": rj, "release.json.sig": Buffer.from(signBytes(priv, rj) + "\n"),
  };
  return { files, pub: loadPublicKey(k.publicPem), other: loadPublicKey(generateKeys().publicPem) };
}

test("byte checks: a consistent release passes; a swapped tarball, a foreign key, a missing .sig or a wrong version each fail in words", () => {
  const { files, pub, other } = fixture();
  const ctx = { slug: SLUG, version: V };
  assert.deepEqual(verifyReleaseBytes(files, pub, ctx), []);
  assert.match(verifyReleaseBytes({ ...files, [`${SLUG}-${V}.tar.gz`]: Buffer.from("tampered") }, pub, ctx).join(), /does not match the tarball/);
  assert.equal(verifyReleaseBytes(files, other, ctx).length, 2, "both signatures refused under another key");
  const noSig = { ...files }; delete noSig[`${SLUG}-${V}.tar.gz.sha256.sig`];
  assert.match(verifyReleaseBytes(noSig, pub, ctx).join(), /sha256\.sig is missing/);
  assert.match(verifyReleaseBytes(files, pub, { slug: SLUG, version: "1.2.4" }).join(), /release\.json says version 1\.2\.3/);
});

const good = {
  version: V, pkg: SLUG, yes: true, allowDirty: false, build: false, branch: "main", dirty: false, headOnOriginMain: true,
  head: "abc", tag: "absent", release: "absent", npmPublished: false, remoteShaMatches: null,
  missingLocal: [], byteProblems: [], releaseCommit: "abc", npmHasShrinkwrap: true, ghAuth: true, npmUser: "me",
  changelog: "- a thing", publicClone: { ok: true },
  assets: releaseAssets({ slug: SLUG, version: V, apk: "waterplane-1.2.3.apk" }), noApk: false,
  npmFromDesktop: false, actionsEnabled: true,
};
const refusals = (f) => preflight(f).checks.filter((c) => !c.ok).map((c) => c.name);

test("preflight: a ready release passes; each missing condition is its own refusal, all reported at once", () => {
  assert.equal(preflight(good).refused, false);
  assert.deepEqual(refusals({ ...good, branch: "feat", dirty: true }), ["on main", "clean tree"]);
  assert.deepEqual(refusals({ ...good, tag: "elsewhere" }), ["tag v1.2.3"]);
  assert.deepEqual(refusals({ ...good, missingLocal: ["release.json.sig"] }), ["assets in dist-release/"]);
  assert.deepEqual(refusals({ ...good, byteProblems: ["x.sig does not verify"] }), ["signatures and .sha256"]);
  assert.deepEqual(refusals({ ...good, releaseCommit: "old" }), ["release.json is this commit"]);
  assert.deepEqual(refusals({ ...good, npmHasShrinkwrap: false }), ["npm tarball carries npm-shrinkwrap.json"]);
  assert.deepEqual(refusals({ ...good, changelog: null }), ["CHANGELOG.md entry"]);
  assert.deepEqual(refusals({ ...good, ghAuth: false }), ["gh auth status"]);
  assert.deepEqual(refusals({ ...good, publicClone: { ok: false, why: "no clone" } }), ["public clone"]);
  assert.deepEqual(refusals({ ...good, mediaClone: { ok: false, why: "no clone" } }), ["media clone"]);
  assert.deepEqual(refusals({ ...good, headOnOriginMain: false }), ["HEAD is on origin/main"]);
});

test("preflight: --allow-dirty waives tree/branch/commit only on a dry run, and is itself refused with --yes", () => {
  const dirty = { ...good, branch: "wip", dirty: true, headOnOriginMain: false, releaseCommit: "abc-dirty", allowDirty: true };
  assert.equal(preflight({ ...dirty, yes: false }).refused, false);
  assert.deepEqual(preflight({ ...dirty, yes: false }).checks.filter((c) => c.waived).map((c) => c.name),
    ["on main", "clean tree", "HEAD is on origin/main", "release.json is this commit"], "a waived check says so, never a bare ok");
  assert.ok(refusals({ ...dirty, yes: true }).includes("--allow-dirty"));
  assert.ok(refusals({ ...dirty, yes: false, releaseCommit: "other-dirty" }).includes("release.json is this commit"), "a dirty build of ANOTHER commit is still refused");
});

test("preflight: released versions — npm without GitHub is refused; a GitHub release is a resume, but only with the same bytes and no rebuild", () => {
  assert.deepEqual(refusals({ ...good, npmPublished: true }), ["not on npm yet"]);
  const resume = { ...good, tag: "head", release: "published", publicClone: null };
  assert.equal(preflight(resume).refused, false);
  assert.equal(preflight({ ...resume, npmPublished: true }).refused, false, "fully done: nothing refused, every step skips");
  assert.deepEqual(refusals({ ...resume, remoteShaMatches: false }), ["same build as the release"]);
  assert.ok(refusals({ ...resume, build: true }).includes("--build on a resumed release"));
});

test("preflight: --build defers the dist-release checks to after the build", () => {
  assert.equal(preflight({ ...good, build: true, missingLocal: undefined, byteProblems: undefined, npmHasShrinkwrap: undefined, releaseCommit: undefined }).refused, false);
});

const ctx = {
  slug: SLUG, name: "Waterplane", version: V, repo: "waterplane-dev/waterplane", pkg: SLUG, build: false, buildArgs: [],
  assets: releaseAssets({ slug: SLUG, version: V, apk: "waterplane-1.2.3.apk" }), publicClone: "/c/pub", accept: null, notesFile: "/t/notes.md", dir: "dist-release",
};
const fresh = { tag: "absent", tagPushed: false, release: "absent", releaseAssets: [], npmPublished: false };
const run = (steps) => steps.filter((s) => !s.skip).map((s) => s.id);

test("plan, first run: verify, tag, public snapshot, install.sh, draft release with every asset, undraft, wait for npm — nothing skipped", () => {
  const steps = planSteps(fresh, ctx);
  assert.deepEqual(run(steps), ["verify", "tag", "public", "install-sh", "release", "undraft", "npm-wait"]);
  const create = steps.find((s) => s.id === "release").cmds[0];
  assert.deepEqual(create.slice(0, 6), ["gh", "release", "create", "v1.2.3", "--repo", "waterplane-dev/waterplane"]);
  assert.ok(create.includes("--draft"));
  for (const n of ["waterplane-1.2.3.tar.gz", "waterplane-1.2.3.tar.gz.sha256", "waterplane-1.2.3.tar.gz.sha256.sig", "release.json", "release.json.sig", "waterplane-1.2.3.apk", "install.sh"]) {
    assert.ok(create.includes(`dist-release/${n}`), n);
  }
  assert.ok(!create.includes("dist-release/waterplane-1.2.3.tgz"), "the npm tarball is not a GitHub asset");
  assert.ok(!steps.flatMap((s) => s.cmds).some((c) => c[0] === "npm" && c[1] === "publish"), "the desktop never runs npm publish by default");
  assert.deepEqual(steps.find((s) => s.id === "public").cmds[0], ["node", "scripts/release/publish-public.mjs", "--tag", "v1.2.3", "--to", "/c/pub", "--commit"]);
  assert.equal(planSteps(fresh, { ...ctx, build: true, buildArgs: ["--apk=/x.apk"] })[0].cmds[0].join(" "), "npm run release:build -- --apk=/x.apk");
});

test("plan: with hosted media, the snapshot gets --media-to and the media repo is pushed before the public one", () => {
  const cmds = planSteps(fresh, { ...ctx, mediaClone: "/c/media" }).find((s) => s.id === "public").cmds;
  assert.deepEqual(cmds[0], ["node", "scripts/release/publish-public.mjs", "--tag", "v1.2.3", "--to", "/c/pub", "--commit", "--media-to", "/c/media"]);
  assert.deepEqual(cmds.slice(1), [["git", "-C", "/c/media", "push", "origin", "main"], ["git", "-C", "/c/pub", "push", "origin", "main"]]);
});

test("plan, resume after the GitHub release and before npm: only the npm wait runs (or the desktop publish, with the flag)", () => {
  const all = ctx.assets.filter((a) => a.github).map((a) => a.name);
  const steps = planSteps({ tag: "head", tagPushed: true, release: "published", releaseAssets: all, npmPublished: false }, ctx);
  assert.deepEqual(run(steps).filter((id) => id !== "install-sh"), ["npm-wait"]);
  const desk = planSteps({ tag: "head", tagPushed: true, release: "published", releaseAssets: all, npmPublished: false }, { ...ctx, npmFromDesktop: true });
  assert.deepEqual(run(desk).filter((id) => id !== "install-sh"), ["npm"]);
  assert.match(steps.find((s) => s.id === "release").skip, /exists/);
  assert.match(steps.find((s) => s.id === "public").skip, /snapshot was pushed/);
});

test("plan, resume a draft that lost an upload: upload only the missing assets, then undraft, then npm", () => {
  const some = ["waterplane-1.2.3.tar.gz", "waterplane-1.2.3.tar.gz.sha256"];
  const steps = planSteps({ tag: "head", tagPushed: true, release: "draft", releaseAssets: some, npmPublished: false }, ctx);
  assert.deepEqual(run(steps), ["install-sh", "upload", "undraft", "npm-wait"], "verify skips: the snapshot went out with the release");
  const up = steps.find((s) => s.id === "upload").cmds[0];
  assert.deepEqual(up.slice(0, 6), ["gh", "release", "upload", "v1.2.3", "--repo", "waterplane-dev/waterplane"]);
  assert.ok(!up.includes("dist-release/waterplane-1.2.3.tar.gz"), "already there, not uploaded again");
  assert.ok(up.includes("dist-release/release.json.sig"));
});

test("plan, everything done: every outward step skips", () => {
  const all = ctx.assets.filter((a) => a.github).map((a) => a.name);
  const done = { tag: "head", tagPushed: true, release: "published", releaseAssets: all, npmPublished: true };
  assert.deepEqual(run(planSteps(done, ctx)), ["install-sh"]);
  assert.deepEqual(run(planSteps(done, { ...ctx, npmFromDesktop: true })), ["install-sh"], "already on npm: the escape hatch publishes nothing either");
  assert.match(planSteps(done, ctx).find((s) => s.id === "npm-wait").skip, /already on npm/);
});

test("plan: npm is the public repo's workflow by default — the desktop only waits for it, after the undraft that starts it", () => {
  const steps = planSteps(fresh, ctx);
  const wait = steps.find((s) => s.id === "npm-wait");
  assert.deepEqual(wait.cmds, [["node", "scripts/release/npm-verify.mjs", "waterplane", "1.2.3", "--wait", String(NPM_WAIT_SECONDS), "--repo", "waterplane-dev/waterplane"]]);
  assert.ok(steps.indexOf(wait) === steps.findIndex((s) => s.id === "undraft") + 1, "right after the undraft (release: published fires the workflow)");
  assert.match(wait.title, /npm-publish workflow.*with provenance/);
  assert.match(wait.hint, new RegExp(`gh workflow run ${NPM_WORKFLOW.replace(".", "\\.")} --repo waterplane-dev/waterplane --ref v1\\.2\\.3 -f tag=v1\\.2\\.3`), "a failed wait names the re-run ON the tag");
  assert.match(wait.hint, /--npm-from-desktop.*WITHOUT provenance/);
  assert.equal(planSteps(fresh, { ...ctx, npmWaitSeconds: 60 }).find((s) => s.id === "npm-wait").cmds[0][5], "60");
  assert.equal(steps.find((s) => s.id === "npm"), undefined);
});

test("plan: --npm-from-desktop publishes dist-release's .tgz here, says WITHOUT provenance, and never claims one", () => {
  const steps = planSteps(fresh, { ...ctx, npmFromDesktop: true });
  assert.deepEqual(run(steps), ["verify", "tag", "public", "install-sh", "release", "undraft", "npm"]);
  const npm = steps.find((s) => s.id === "npm");
  assert.deepEqual(npm.cmds, [["npm", "publish", "dist-release/waterplane-1.2.3.tgz", "--access", "public"]]);
  assert.match(npm.title, /WITHOUT provenance/);
  assert.ok(!steps.flatMap((s) => s.cmds).flat().includes("--provenance"), "a desktop has no OIDC identity: --provenance would fail there");
  assert.equal(steps.find((s) => s.id === "npm-wait"), undefined);
});

test("preflight: npm login is needed only to publish from the desktop; the workflow route needs Actions on the public repo", () => {
  assert.equal(preflight({ ...good, npmUser: null }).refused, false, "the default route publishes from CI: no npm login here");
  assert.deepEqual(refusals({ ...good, npmFromDesktop: true, npmUser: null, actionsEnabled: null }), ["npm whoami"]);
  assert.equal(preflight({ ...good, npmFromDesktop: true, actionsEnabled: false }).refused, false, "the escape hatch does not need Actions");
  assert.deepEqual(refusals({ ...good, actionsEnabled: false }), ["Actions on the public repo"]);
  assert.match(preflight({ ...good, actionsEnabled: false }).checks.find((c) => !c.ok).why, /enable them.*--npm-from-desktop/);
  assert.deepEqual(refusals({ ...good, actionsEnabled: null }), ["Actions on the public repo"], "unreadable is refused, never assumed on");
  assert.match(preflight({ ...good, actionsEnabled: undefined }).checks.find((c) => !c.ok).why, /could not read/);
  const resumedDone = { ...good, tag: "head", release: "published", publicClone: null, npmPublished: true, actionsEnabled: null };
  assert.equal(preflight(resumedDone).refused, false, "already on npm: whether Actions are on no longer matters");
});

test("npm reads: version present, provenance attestation, the workflow run for a tag", () => {
  assert.equal(readNpmHasVersion("1.2.3\n", V), true);
  assert.equal(readNpmHasVersion("'1.2.2'\n'1.2.3'", V), true, "a range query lists quoted versions");
  assert.equal(readNpmHasVersion("", V), false);
  assert.equal(readNpmHasVersion("1.2.30", V), false);
  const att = JSON.stringify({ url: "https://registry.npmjs.org/-/npm/v1/attestations/waterplane@1.2.3", provenance: { predicateType: "https://slsa.dev/provenance/v1" } });
  assert.equal(readProvenance(att), true);
  assert.equal(readProvenance(""), false, "npm prints nothing when the field is absent");
  assert.equal(readProvenance(JSON.stringify({ url: "x" })), false, "attestations without a provenance one (a publish attestation only)");
  assert.equal(readProvenance(JSON.stringify({ provenance: { predicateType: "https://example.com/not-slsa" } })), false);
  assert.equal(readProvenance("npm ERR! code E500"), null, "unreadable is never read as either");
  assert.equal(readProvenance("[]"), null);
  const runs = JSON.stringify([
    { headBranch: "main", status: "completed", conclusion: "success", url: "u0" },
    { headBranch: "v1.2.3", status: "in_progress", conclusion: "", url: "u1" },
    { headBranch: "v1.2.3", status: "completed", conclusion: "failure", url: "u2" },
  ]);
  assert.deepEqual(readWorkflowRun(runs, "v1.2.3"), { status: "in_progress", conclusion: "", url: "u1" }, "the newest run for the tag, not an older failed one");
  assert.equal(readWorkflowRun(runs, "v9.9.9"), null);
  assert.equal(readWorkflowRun("not json", "v1.2.3"), null);
});

test("plan: a local tag on HEAD that never reached origin is pushed, not re-created", () => {
  const tag = planSteps({ ...fresh, tag: "head" }, ctx).find((s) => s.id === "tag");
  assert.deepEqual(tag.cmds, [["git", "push", "origin", "refs/tags/v1.2.3"]]);
});

test("shellLine quotes what a shell would split; readHasShrinkwrap reads npm view's answer", () => {
  assert.equal(shellLine(["gh", "release", "create", "--title", "Waterplane 1.2.3", "it's"]), `gh release create --title 'Waterplane 1.2.3' 'it'\\''s'`);
  assert.equal(readHasShrinkwrap("true\n"), true);
  assert.equal(readHasShrinkwrap(""), false, "npm prints nothing when the field is absent");
  assert.equal(readHasShrinkwrap("npm ERR! weird"), null);
});

test("plan: the public snapshot is verified before ANYTHING is pushed, and a failing verify is a failing step", () => {
  const steps = planSteps(fresh, ctx);
  const verify = steps.findIndex((s) => s.id === "verify");
  assert.deepEqual(steps[verify].cmds, [["node", "scripts/verify-public-tree.mjs", "--rev", "HEAD"]]);
  const outward = (c) => (c[0] === "git" && c.includes("push")) || (c[0] === "gh") || (c[0] === "npm" && c[1] === "publish");
  const firstOut = steps.findIndex((s) => s.cmds.some(outward));
  assert.ok(verify >= 0 && verify < firstOut, "verify runs before the first push / upload / publish");
  const built = planSteps(fresh, { ...ctx, build: true });
  assert.deepEqual(built.slice(0, 2).map((s) => s.id), ["build", "verify"], "after a build, before the tag");
  assert.equal(steps[verify].skip, null);
  assert.equal(steps[verify].cmds.length, 1, "one command: its non-zero exit stops the run like any step's");
});

test("undraft needs an APK asset unless --no-apk: refused in the preflight and stopped in the plan", () => {
  const bare = releaseAssets({ slug: SLUG, version: V });
  assert.deepEqual(refusals({ ...good, assets: bare }), ["APK asset"]);
  assert.match(preflight({ ...good, assets: bare }).checks.find((c) => c.name === "APK asset").why, /--no-apk/);
  assert.equal(preflight({ ...good, assets: bare, noApk: true }).refused, false, "--no-apk publishes without one, on purpose");
  assert.deepEqual(refusals({ ...good, noApk: true }), ["--no-apk"], "--no-apk with an APK named is a contradiction");
  assert.equal(preflight({ ...good, assets: bare, release: "published", tag: "head", publicClone: null }).refused, false, "already undrafted: nothing to guard");
  const undraft = (st, c) => planSteps(st, c).find((s) => s.id === "undraft");
  assert.match(undraft(fresh, { ...ctx, assets: bare }).refuse, /APK/);
  assert.equal(undraft(fresh, { ...ctx, assets: bare, noApk: true }).refuse, undefined);
  assert.equal(undraft(fresh, ctx).refuse, undefined);
  assert.equal(undraft({ ...fresh, release: "published" }, { ...ctx, assets: bare }).refuse, undefined, "published: the step skips, nothing to refuse");
});

test("npm-verify's wait: 3 only after npm ANSWERED not-there; never asking is a 1 (the header's \"could not ask\")", () => {
  const spec = "waterplane@1.2.3";
  const d = (o) => npmWaitDecision({ spec, elapsed: "0m05s", ...o });
  assert.deepEqual(d({ answer: true, streak: 2, expired: true }), { streak: 0, stop: { code: 0, text: `${spec} is on npm (0m05s).` } });
  // asked, not there: keep polling until the wait is spent, then 3
  assert.deepEqual(d({ answer: false, streak: 1, expired: false, wait: 60 }), { streak: 0, stop: null });
  assert.deepEqual(d({ answer: false, expired: true, wait: 0 }).stop, { code: 3, text: `${spec} is not on npm.` });
  assert.deepEqual(d({ answer: false, expired: true, wait: 300 }).stop, { code: 3, text: `${spec} is not on npm after 0m05s.` });
  // could not ask: `--wait 0` with a failed npm view used to exit 3, claiming an answer it never got
  const dead0 = d({ answer: null, expired: true, wait: 0 });
  assert.equal(dead0.stop.code, 1);
  assert.match(dead0.stop.text, /could not ask npm/);
  assert.equal(d({ answer: null, streak: 0, expired: false, wait: 60 }).stop, null, "one failed ask while waiting is retried");
  assert.equal(d({ answer: null, streak: 0, expired: false, wait: 60 }).streak, 1);
  const third = d({ answer: null, streak: 2, expired: false, wait: 60 });
  assert.equal(third.stop.code, 1, "three failed asks in a row stop the wait");
  assert.match(third.stop.text, /three times in a row/);
  // a real answer resets the count, so two flaky asks around a 404 never add up
  assert.equal(d({ answer: false, streak: 2, expired: false, wait: 60 }).streak, 0);
  // the last answer decides at the deadline: null after a false is still "could not ask"
  assert.equal(d({ answer: null, streak: 0, expired: true, wait: 60 }).stop.code, 1);
});

test("npm-verify tells a failed workflow run to check npm first: a run can fail after publishing", () => {
  const src = readFileSync(new URL("./npm-verify.mjs", import.meta.url), "utf8");
  assert.match(src, /check \\`npm view \$\{SPEC\}\\` before re-running \(a re-run skips a version already on npm\)/);
  assert.doesNotMatch(src, /without publishing/);
});
