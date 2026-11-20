/**
 * App glossary guard (whole-app journey spec D1, glossary §4): one word per thing on every phone
 * screen, the README and the guide. Scans only what a person READS (`tools/glossaryscan.mjs`): JSX
 * text and string literals in packages/web/src and every in-repo extension's web/ (the vault keeps
 * its own list, `tools/vaultglossary.test.mjs`), plus README.md and docs/guide.md prose outside code.
 * Not scanned: tests, the demo's recorded scenarios (a transcript is Claude's words, not the app's).
 *
 * RATCHET: tools/appglossary.baseline.json (file -> hits). A count may only go DOWN: a file over its
 * baseline, or a new file with hits, fails. A count under its baseline is printed, never a failure,
 * so packages built in parallel never write one file; `node tools/appglossary.test.mjs --write`
 * LOWERS the baseline to what is there (it never raises one), and the README package (P17) takes it
 * to zero. `--init` rewrites it as found. `glossary-ignore` in a trailing comment skips a line.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { makeGlossary } from "./glossaryscan.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const BASELINE = join(ROOT, "tools/appglossary.baseline.json");

/** word (regex source) -> what to say instead (glossary §1 and §4). */
export const BANNED = {
  "repo readings": "Setup & health",
  "repo setup": "Setup & health",
  "repo health": "Setup & health (the number: health score)",
  "setup check": "Setup & health › Checks (a line of it: a check)",
  "skills & plugins": "Setup & health › Skills, or Plugins",
  "agent readings": "Setup & health",
  "health index": "health score",
  "connection health": "Connection",
  "connection & speed test": "Connection (tab Speed test)",
  "queued messages": "Waiting work › Queued",
  "automation": "Waiting work › Scheduled",
  "prompt pad": "Pad",
  "re-time": "Change time",
  "launcher": "Home",
  "outbox": "From Claude (the path `.claude/outbox/` in backticks)",
  "inbox": "From my phone (the path `.claude/inbox/` in backticks)",
  "gallery": "Images & documents",
  "host clip": "To desktop clipboard",
  "the host": "the desktop",
  "hosts": "Desktops",
  "peer desktop": "helper desktop",
  "peer": "helper desktop",
  "rescan": "Find repos",
  "later": "when free / New session / backlog",
  "week-end burn": "usage pace",
  "review": "Changes",
  "diff": "Changes",
  "token statistics": "Token usage",
  "download rules": "Downloads",
  "unsaved": "not sent (a send) / saved (a file)",
  "Manage": "the screen's title (Waiting work, ...)",
  "needs you": "N questions",
  "worktree": "copy of the repo / branch copy",
  "daemon": "desktop",
  "pane": "(drop it)",
};
/** "Manage" the button is banned; "manage" the verb inside a sentence is not (glossary §4). */
const CASE_SENSITIVE = ["Manage"];

/** Phrases that stay (glossary §4 allow-list). Code and paths in backticks are skipped already. */
export const EXCEPTIONS = [
  /\.claude\/(outbox|inbox)\/?/g,
  /\/api\/peer\S*/g,
  /\bWATERPLANE_HOST\b/g,
  /\bhosted backends?\b/gi,
];

const G = makeGlossary({ banned: BANNED, exceptions: EXCEPTIONS, caseSensitive: CASE_SENSITIVE });
export const { bannedIn, scanSource, scanMarkdown } = G;

const SKIP_DIR = new Set(["node_modules", "dist", "scenarios"]);
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (!SKIP_DIR.has(e)) walk(p, out); }
    else if (/\.tsx?$/.test(e) && !/\.test\./.test(e) && !/\.d\.ts$/.test(e) && !/demofixture/i.test(e)) out.push(p);
  }
  return out;
}

function sources() {
  const out = walk(join(ROOT, "packages/web/src"));
  const ext = join(ROOT, "packages/extensions");
  if (existsSync(ext)) for (const e of readdirSync(ext).sort()) if (e !== "vault") walk(join(ext, e, "web"), out);
  return out.sort();
}
const PROSE = ["README.md", "docs/guide.md"];

/** file (repo-relative) -> hits, only files with hits */
export function scanAll() {
  const res = {};
  for (const f of sources()) {
    const h = scanSource(readFileSync(f, "utf8"), f);
    if (h.length) res[relative(ROOT, f)] = h;
  }
  for (const rel of PROSE) {
    const f = join(ROOT, rel);
    if (!existsSync(f)) continue;
    const h = scanMarkdown(readFileSync(f, "utf8"));
    if (h.length) res[rel] = h;
  }
  return res;
}

const counts = (all) => Object.fromEntries(Object.entries(all).map(([f, h]) => [f, h.length]).sort(([a], [b]) => a.localeCompare(b)));
const readBase = () => (existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {});

const hitsArg = process.argv.find((a) => a.startsWith("--hits="));
if (process.argv.includes("--write") || process.argv.includes("--init") || hitsArg) {
  const all = scanAll();
  const now = counts(all);
  if (process.argv.includes("--init")) writeFileSync(BASELINE, JSON.stringify(now, null, 2) + "\n");
  else if (process.argv.includes("--write")) {
    const base = readBase();
    const lowered = Object.fromEntries(Object.entries(base).map(([f, b]) => [f, Math.min(b, now[f] ?? 0)]).filter(([, n]) => n > 0));
    writeFileSync(BASELINE, JSON.stringify(lowered, null, 2) + "\n");
    const over = Object.entries(now).filter(([f, n]) => n > (base[f] ?? 0));
    if (over.length) console.log(`not raised (fix these instead): ${over.map(([f, n]) => `${f} ${n} > ${base[f] ?? 0}`).join(", ")}`);
  }
  console.log(`${Object.values(now).reduce((a, b) => a + b, 0)} hits in ${Object.keys(now).length} files`);
  if (hitsArg) writeFileSync(hitsArg.slice(7), JSON.stringify(all, null, 1));
} else {
  test("app glossary ratchet: retired words on phone screens, the README and the guide only go down", () => {
    const base = readBase();
    const now = scanAll();
    const bad = [];
    const lower = [];
    for (const [f, hits] of Object.entries(now)) {
      const b = base[f];
      if (b === undefined) bad.push(`${f}: ${hits.length} retired word(s) and no baseline entry:\n` + hits.map((h) => `    ${f}:${h.line} "${h.word}" -> ${h.hint}  | ${h.text}`).join("\n"));
      else if (hits.length > b) bad.push(`${f}: ${hits.length} retired words, baseline ${b}. New ones are among:\n` + hits.map((h) => `    ${f}:${h.line} "${h.word}" -> ${h.hint}  | ${h.text}`).join("\n"));
      else if (hits.length < b) lower.push(`${f} ${b} -> ${hits.length}`);
    }
    for (const [f, b] of Object.entries(base)) if (!now[f] && b > 0) lower.push(`${f} ${b} -> 0`);
    if (lower.length) console.log(`the baseline can go down (node tools/appglossary.test.mjs --write): ${lower.join(", ")}`);
    assert.equal(bad.length, 0, "\n" + bad.join("\n"));
  });

  test("app glossary words, exceptions and skips", () => {
    assert.equal(bannedIn("Open the gallery").length, 1);
    assert.equal(bannedIn("Saved to `.claude/outbox/a.png`").length, 0);
    assert.equal(bannedIn("files in .claude/outbox/ wait for you").length, 0);
    assert.equal(bannedIn("calls /api/peer/job").length, 0);
    assert.equal(bannedIn("set WATERPLANE_HOST first").length, 0);
    assert.equal(bannedIn("Manage").length, 1);
    assert.equal(bannedIn("we manage it for you").length, 0, "manage the verb stays");
    assert.equal(bannedIn("Week-end burn").length, 1);
    assert.equal(bannedIn("start it later").length, 1);
    // A hyphenated word opening a visible string is NOT code unless a flag or path follows it.
    assert.equal(scanSource('const t = "re-time the 3 on it";', "x.ts").length, 1, "prose starting with re-time is still scanned");
    assert.equal(scanSource('const t = "re-read the host\'s own counters";', "x.ts").length, 1);
    assert.equal(scanSource('const t = "some-tool --week-end-burn ./x";', "x.ts").length, 0, "a hyphenated command line reads as code");
    assert.equal(scanSource('const a = <div className="gallery">Images &amp; documents</div>;', "x.tsx").length, 0);
    assert.equal(scanSource('const a = <p>Open the launcher</p>;', "x.tsx").length, 1);
    assert.equal(scanSource('const k = o === "backlog" || o === "gallery";', "x.ts").length, 0);
    assert.equal(scanMarkdown("```\nlater\n```\nnow `outbox` is fine").length, 0);
  });
}
