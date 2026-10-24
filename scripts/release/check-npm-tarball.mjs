#!/usr/bin/env node
// Check the npm tarball `npm run release:build` left in dist-release/, the way the public repo's
// npm-publish workflow checks it before `npm publish`: it is <slug>@<version> (package.json's
// version), names the public repo as its repository (npm checks provenance against it) and carries
// package/npm-shrinkwrap.json. Read-only; run from the repo root.
// `scripts/verify-public-tree.mjs` runs it in the copy. Pure part: public-lib.mjs npmTarballProblems.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npmTarballProblems } from "./public-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { BRAND } = await import(join(ROOT, "packages/shared/dist/brand.js"));
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const tgz = join(ROOT, "dist-release", `${BRAND.slug}-${version}.tgz`);
if (!existsSync(tgz)) {
  console.error(`check-npm-tarball: release:build made no dist-release/${BRAND.slug}-${version}.tgz`);
  process.exit(1);
}
const tar = (...a) => execFileSync("tar", [...a, tgz], { encoding: "utf8", maxBuffer: 64 << 20 });
let listing = [], pkgJson = null;
try { listing = tar("-tzf").split("\n").filter(Boolean); } catch { /* reported as problems */ }
try { pkgJson = execFileSync("tar", ["-xOzf", tgz, "package/package.json"], { encoding: "utf8" }); } catch { /* ditto */ }
const problems = npmTarballProblems({ slug: BRAND.slug, version, listing, pkgJson, org: BRAND.githubOrg });
for (const p of problems) console.error(`check-npm-tarball: ${p}`);
if (problems.length) process.exit(1);
console.log(`check-npm-tarball: dist-release/${BRAND.slug}-${version}.tgz is ${BRAND.slug}@${version}, names github.com/${BRAND.githubOrg}/${BRAND.slug} and has package/npm-shrinkwrap.json`);
