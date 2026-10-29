// node --test: the properties of .github/workflows/npm-publish.yml (live only in the public repo; the
// job guard skips it here) that a review would not catch —
// it can only run in the public repo the brand names, holds no more permission than OIDC needs,
// publishes with provenance through trusted publishing (no token), builds the tarball from the tag
// itself, and pins every action by commit. Read as text: no YAML parser is a dependency of this
// repo, and each rule here is one line of the file. Why: docs/notes/distribution.md.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NPM_WORKFLOW } from "./publish-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const yml = readFileSync(join(ROOT, ".github/workflows", NPM_WORKFLOW), "utf8");
const code = yml.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"); // comments may name anything
const { BRAND } = await import(join(ROOT, "packages/shared/dist/brand.js"));

test("the job runs only in the public repo the brand names", () => {
  const guards = [...code.matchAll(/^\s+if: github\.repository == '([^']+)'\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(guards, [`${BRAND.githubOrg}/${BRAND.slug}`], "one job-level guard, equal to BRAND.githubOrg/BRAND.slug");
  assert.match(code, /\[ "\$REPO" != "\$GITHUB_REPOSITORY" \]/, "and checked again against the checked-out brand");
});

test("triggers: a published release, or a hand re-run that names its tag", () => {
  assert.match(code, /^on:\n  release:\n    types: \[published\]\n  workflow_dispatch:\n    inputs:\n      tag:\n/m);
  assert.doesNotMatch(code, /^\s+(push|pull_request|pull_request_target|schedule|workflow_run):/m, "nothing else can start a publish");
  assert.match(code, /\[ "\$GITHUB_REF" != "refs\/tags\/\$TAG" \]/, "a run not started ON the tag stops: provenance would attest another commit");
});

test("permissions: read-only at the top, the write grants only on the jobs that need them", () => {
  const strip = (b) => b.trim().split("\n").map((l) => l.replace(/\s+#.*$/, "").trim()).sort();
  const top = /^permissions:\n((?: {2}.*\n)+)/m.exec(code)?.[1] ?? "";
  assert.deepEqual(strip(top), ["contents: read"], "the workflow-level token is read-only");
  const job = /^ {4}permissions:\n((?: {6}.*\n)+)/m.exec(code)?.[1] ?? "";
  assert.deepEqual(strip(job), ["attestations: write", "contents: read", "id-token: write"], "OIDC + attestation, nothing else");
  assert.equal((code.match(/^\s*permissions:/gm) ?? []).length, 3, "one workflow block, one per job");
  assert.match(code, /actions\/attest-build-provenance@[0-9a-f]{40}[\s\S]*?subject-path: dist-release\/\*\.tgz/, "the tarball is attested");
});

test("publish: the tag's own build, with --provenance, through trusted publishing — no token anywhere", () => {
  assert.match(code, /npm run release:build -- --unsigned\n/, "built in CI from the tag; no signing key, no APK");
  assert.doesNotMatch(code, /--apk|--no-build|--allow-dirty/);
  assert.match(code, /npm publish "\$TGZ" --provenance --access public/);
  assert.match(code, /TGZ="\.\/dist-release\//, "a path, not a spec: bare dist-release/x.tgz is read as a GitHub user/repo");
  assert.doesNotMatch(code, /secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN/, "OIDC only: no long-lived npm token");
  assert.match(code, /\[ "v\$VERSION" != "\$TAG" \]/, "package.json's version must be the tag");
  assert.match(code, /\[ "\$GOT" != "\$PKG@\$VERSION" \]/, "and the built tarball's too");
  assert.doesNotMatch(code, /^\s*npm (install|i) -g/m, "the npm CLI is the pinned Node's own: a global install is an unpinned download to Scorecard");
  assert.match(code, /is older than 11\.5\.1, which trusted publishing needs/, "and its floor is checked");
  assert.match(code, /node scripts\/release\/npm-verify\.mjs "\$PKG" "\$VERSION" --wait \d+ --check/, "checked on npm afterwards: shrinkwrap and provenance");
  assert.match(code, /published=true[\s\S]*already on npm: nothing to publish, skipped/, "an existing version is a clean skip");
});

test("every action is pinned by full commit SHA, and the checkout keeps no credentials", () => {
  const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 2);
  for (const u of uses) assert.match(u, /^[\w-]+\/[\w-]+@[0-9a-f]{40}$/, u);
  assert.match(code, /persist-credentials: false/);
  assert.doesNotMatch(code, /cache: npm/, "a publishing job restores no cache another run could have written");
});

test("provenance to the release: its own job, contents: write and nothing else, after a successful publish", () => {
  const job = (/^  provenance-to-release:\n((?: {4}.*\n|\n)+)/m.exec(code + "\n")?.[1] ?? "").replace(/\s+#.*$/gm, "");
  assert.ok(job, "the job exists");
  assert.match(job, /^ {4}needs: publish$/m, "runs only after the publish job succeeded (and so only in the public repo)");
  assert.match(job, /^ {4}if: needs\.publish\.outputs\.attested == 'true'$/m, "and only when this run made an attestation");
  assert.match(job, /^ {4}permissions:\n {6}contents: write\n(?! {6})/m, "contents: write only, never beside id-token");
  assert.doesNotMatch(job, /actions\/checkout|npm |id-token/, "checks out and runs nothing from the repo");
  assert.match(job, /gh release upload "\$TAG" provenance\/\*\.intoto\.jsonl --clobber/, "attaches only the attestation, under the name Scorecard reads");
  assert.match(code, /id: attest\n[\s\S]*?cp "\$\{\{ steps\.attest\.outputs\.bundle-path \}\}" "provenance\/\$\(basename "\$TGZ"\)\.intoto\.jsonl"/, "the bundle is the publish job's own attestation of the tarball");
});
