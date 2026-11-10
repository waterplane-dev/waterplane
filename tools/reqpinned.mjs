/**
 * `node tools/reqpinned.mjs` — ONE number for the repo-health sheet (`reqPinned` in
 * `.waterplane-shared/health.json`): the percentage of live requirement IDs
 * (docs/requirements/*.md, status `shipped`) that some test file names.
 *
 * Live = `shipped`. `requested` has nothing to test yet, `superseded` and `dropped` are
 * retired, and any other status word is hidden from the requirements list too (skill
 * `requirements`). A test names a requirement by writing its ID (R-<area>-<nnn>) anywhere
 * in the file, usually in a title or a comment. Test files are git-tracked files that are
 * `*.test.*`, `scripts/e2e-*`, `scripts/ui/*`, an extension's `e2e/` or `packages/host/test/`.
 * A pin by name proves the author thought of the requirement, not that the test is good.
 *
 * Exits 1 with the reason on stderr when there is no live requirement to measure
 * (an absent reading, never 0).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ID = "R-[a-z][a-z0-9-]*-\\d{3}";
const HEAD_RE = new RegExp(`^### (${ID}) · ([a-z]+)\\s*$`, "gm");

/** IDs whose status is `shipped`, from the text of one requirements file. */
export function liveIds(text) {
  const out = [];
  for (const m of text.matchAll(HEAD_RE)) if (m[2] === "shipped") out.push(m[1]);
  return out;
}
/** Every requirement ID a test's text mentions. */
export function idsIn(text) {
  return new Set(text.match(new RegExp(ID, "g")) ?? []);
}
export const isTestFile = (rel) =>
  /\.test\.(mjs|js|ts|tsx)$/.test(rel) || /^scripts\/e2e-[^/]*\.mjs$/.test(rel) || /^scripts\/ui\//.test(rel) ||
  /^packages\/[^/]+(\/[^/]+)?\/e2e\//.test(rel) || /^packages\/host\/test\//.test(rel);

/** { live, pinned } from the live IDs and the test texts. */
export function measure(live, testTexts) {
  const seen = new Set();
  for (const t of testTexts) for (const id of idsIn(t)) seen.add(id);
  const uniq = [...new Set(live)];
  return { live: uniq.length, pinned: uniq.filter((id) => seen.has(id)).length };
}

function main(root) {
  const dir = join(root, "docs/requirements");
  let names;
  try { names = readdirSync(dir); } catch { console.error("no docs/requirements/ folder here"); process.exit(1); }
  const live = names.filter((f) => f.endsWith(".md") && f !== "README.md")
    .flatMap((f) => liveIds(readFileSync(join(dir, f), "utf8")));
  if (!live.length) { console.error("no shipped requirement found under docs/requirements/"); process.exit(1); }
  let listed;
  try { listed = execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] }).toString(); }
  catch { console.error("not a git checkout: the test files are the tracked ones, so there is nothing to count"); process.exit(1); }
  const files = listed.split("\0").filter(isTestFile);
  const texts = [];
  for (const f of files) { try { texts.push(readFileSync(join(root, f), "utf8")); } catch { /* deleted in the tree */ } }
  const { live: n, pinned } = measure(live, texts);
  console.log(Math.round((pinned / n) * 1000) / 10);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.cwd());
