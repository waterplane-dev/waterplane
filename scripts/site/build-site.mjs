#!/usr/bin/env node
// waterplane.dev from the README (the why and the marker format: site-lib.mjs).
//
//   node scripts/site/build-site.mjs              # refill site/index.html's slots from README.md
//   node scripts/site/build-site.mjs --check      # exit 1 if site/index.html is behind the README
//   node scripts/site/build-site.mjs --out DIR    # also assemble the deployable site in DIR
//
// --out writes site/ plus every picture the page shows (copied from docs/ into assets/). DIR is
// the clone of the Pages repo (waterplane-dev.github.io) or a scratch dir for a preview: its
// contents are replaced, its dot-entries (.git, .claude/) are kept, and nothing is committed or pushed. A DIR that is
// neither empty nor holds a CNAME is refused, so a typo cannot empty some other folder.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assetName, imageSize, renderSite } from "./site-lib.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SITE = join(ROOT, "site");
const PAGE = join(SITE, "index.html");

/** The page as the README says it should be. */
export function build() {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  // The repo the README's relative links live in: its own `git clone` line, so this reads files
  // only (no dist/ for the brand) and runs in the guards' edit tier.
  const clone = /git clone (https:\/\/github\.com\/[\w.-]+\/[\w.-]+?)\.git/.exec(readme);
  if (!clone) throw new Error("README.md: no `git clone https://github.com/<org>/<repo>.git` line to take the repo URL from");
  return renderSite(readFileSync(PAGE, "utf8"), readme, {
    repoUrl: clone[1],
    dims: (src) => imageSize(readFileSync(join(ROOT, src)), src),
  });
}

function assemble(out, media) {
  if (existsSync(out)) {
    const entries = readdirSync(out);
    if (entries.length && !entries.includes("CNAME")) {
      console.error(`build-site: ${out} is not empty and holds no CNAME; refusing to replace it`);
      process.exit(2);
    }
    for (const e of entries) if (!e.startsWith(".")) rmSync(join(out, e), { recursive: true, force: true });
  }
  mkdirSync(out, { recursive: true });
  cpSync(SITE, out, { recursive: true });
  for (const src of media) cpSync(join(ROOT, src), join(out, "assets", assetName(src)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const { html, media } = build();
  const current = readFileSync(PAGE, "utf8");
  if (args.includes("--check")) {
    if (html !== current) {
      console.error("site/index.html is behind README.md: run `npm run site`");
      process.exit(1);
    }
  } else if (html !== current) {
    writeFileSync(PAGE, html);
    console.log("site/index.html refilled from README.md");
  }
  const i = args.indexOf("--out");
  if (i >= 0) {
    if (!args[i + 1]) { console.error("build-site: --out needs a directory"); process.exit(2); }
    assemble(args[i + 1], media);
    console.log(`site assembled in ${args[i + 1]} (${media.size} pictures from docs/)`);
  }
}
