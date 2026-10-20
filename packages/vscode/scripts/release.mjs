// `npm run release` — publish this version to the VS Code Marketplace and Open VSX, or say why not.
//
//   npm run release                         checks only: what a publish would do (no tokens needed)
//   npm run release -- --publish            checks, `npm run package`, publish, then ask each registry
//   npm run release -- --publish --only openvsx
//
// The tokens come from the environment, as vsce and ovsx read them: VSCE_PAT (Marketplace, scope
// Marketplace → Manage) and OVSX_PAT (Open VSX). A registry that already has this version is
// skipped, so a run that stopped half way is safe to repeat. The version bump stays by hand
// (`npm version minor` + the CHANGELOG heading): choosing a version is a person's call.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REGISTRIES, marketplaceVersions, openVsxVersions, planRelease, readmeImages } from "./release-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const ID = `${pkg.publisher}.${pkg.name}`;
// Where the listing reads the README's images from: the `--baseImagesUrl` `npm run package` passes vsce.
const RAW = pkg.scripts.package.match(/--baseImagesUrl (\S+)/)?.[1];
if (!RAW) { console.error("package.json's package script passes no --baseImagesUrl"); process.exit(2); }

const args = process.argv.slice(2);
const publish = args.includes("--publish");
const onlyAt = args.indexOf("--only");
const only = onlyAt >= 0 ? args[onlyAt + 1].split(",") : Object.keys(REGISTRIES);
for (const id of only) if (!REGISTRIES[id]) { console.error(`unknown registry "${id}" (${Object.keys(REGISTRIES).join(", ")})`); process.exit(2); }

async function published(id) {
  try {
    if (id === "marketplace") {
      const r = await fetch("https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery", {
        method: "POST",
        headers: { accept: "application/json;api-version=7.2-preview.1", "content-type": "application/json" },
        body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: ID }] }], flags: 0x1 }),
      });
      return r.ok ? marketplaceVersions(await r.json()) : null;
    }
    const r = await fetch(`https://open-vsx.org/api/${pkg.publisher}/${pkg.name}`);
    if (r.status === 404) return [];
    return r.ok ? openVsxVersions(await r.json()) : null;
  } catch {
    return null;
  }
}

async function status(url) {
  try { return (await fetch(url, { method: "HEAD" })).status; } catch { return 0; }
}

async function facts() {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const urls = readmeImages(readme).map((p) => `${RAW}/${p.replace(/^\.\//, "")}`);
  const dirty = execFileSync("git", ["status", "--porcelain", "--", "."], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter((l) => l && !/\.vsix$/.test(l));
  const pub = {};
  for (const id of only) pub[id] = await published(id);
  return {
    name: pkg.name,
    version: pkg.version,
    changelog: readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"),
    scripts: pkg.scripts,
    dirty,
    images: await Promise.all(urls.map(async (url) => ({ url, status: await status(url) }))),
    published: pub,
    only,
    tokens: Object.fromEntries(Object.values(REGISTRIES).map((r) => [r.token, !!process.env[r.token]])),
    publish,
  };
}

const run = (cmd, argv) => {
  const r = spawnSync(join(ROOT, "node_modules", ".bin", cmd), argv, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) { console.error(`\n${cmd} ${argv.join(" ")} failed (exit ${r.status}).`); process.exit(1); }
};

const plan = planRelease(await facts());
console.log(`${ID} ${pkg.version}`);
for (const s of plan.skipped) console.log(`  skip: ${s}`);
for (const p of plan.problems) console.log(`  stop: ${p}`);
if (plan.problems.length) process.exit(1);
if (!plan.targets.length) process.exit(0);
console.log(`  ${publish ? "publishing to" : "would publish to"}: ${plan.targets.map((t) => REGISTRIES[t].label).join(", ")}`);
if (!publish) { console.log(`\nchecks pass. To publish: npm run release -- --publish (with ${plan.targets.map((t) => REGISTRIES[t].token).join(" and ")} set)`); process.exit(0); }

const npm = spawnSync("npm", ["run", "package"], { cwd: ROOT, stdio: "inherit" });
if (npm.status !== 0) { console.error("\nnpm run package failed: nothing was published."); process.exit(1); }
if (plan.targets.includes("marketplace")) run("vsce", ["publish", "-i", plan.vsix]);
if (plan.targets.includes("openvsx")) run("ovsx", ["publish", plan.vsix]);

// Ask each registry until it lists the version (the Marketplace lists it while it still verifies).
const deadline = Date.now() + 5 * 60_000;
let waiting = [...plan.targets];
while (waiting.length && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 10_000));
  const still = [];
  for (const id of waiting) if (!(await published(id))?.includes(pkg.version)) still.push(id);
  waiting = still;
}
const pages = {
  marketplace: `https://marketplace.visualstudio.com/items?itemName=${ID}`,
  openvsx: `https://open-vsx.org/extension/${pkg.publisher}/${pkg.name}`,
};
for (const id of plan.targets)
  console.log(`${waiting.includes(id) ? "NOT LISTED YET" : "listed"}: ${REGISTRIES[id].label} ${pkg.version} — ${pages[id]}`);
process.exit(waiting.length ? 1 : 0);
