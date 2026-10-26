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

test("permissions: read-only at the top, the write grants only on the publish job", () => {
  const strip = (b) => b.trim().split("\n").map((l) => l.replace(/\s+#.*$/, "").trim()).sort();
  const top = /^permissions:\n((?: {2}.*\n)+)/m.exec(code)?.[1] ?? "";
  assert.deepEqual(strip(top), ["contents: read"], "the workflow-level token is read-only");
  const job = /^ {4}permissions:\n((?: {6}.*\n)+)/m.exec(code)?.[1] ?? "";
  assert.deepEqual(strip(job), ["attestations: write", "contents: read", "id-token: write"], "OIDC + attestation, nothing else");
  assert.equal((code.match(/^\s*permissions:/gm) ?? []).length, 2, "one workflow block, one job block");
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
  assert.match(code, /npm install -g npm@\d+\.\d+\.\d+\n/, "the npm CLI is pinned exactly");
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
