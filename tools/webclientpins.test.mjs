/**
 * Pins for splitting the phone's HTTP client, the gallery and the repo-health
 * words (docs/notes/webclient-architecture.md). Read as TEXT / by import, so
 * the same assertions hold before the move, after each cut and after the last.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import ts from "typescript";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "packages", "web", "src");

// ── api.ts: the client object is the same shape it was ──────────────────────
const API_KEYS = {"repos":0,"slash":0,"external":0,"transcript":0,"scrollback":0,"transcriptTools":0,"shellDetail":0,"contextSeries":0,"tokenStats":0,"localUsage":0,"peerJobs":0,"backendTokens":0,"usageLog":0,"usageLogSource":0,"tokenWindows":0,"costWindow":0,"inbox":0,"markInboxSeen":0,"markOutboxSeen":0,"artifacts":0,"search":0,"uploadInbox":0,"fileBlob":0,"deleteInbox":0,"deleteArtifact":0,"sweepPlan":0,"sweepRun":0,"transportSurvey":0,"appReadiness":0,"hostStore":0,"hostStoreClear":0,"newFolder":0,"newRepo":0,"cloneRepo":0,"onboardPlan":0,"onboardJob":0,"onboardStart":0,"onboardResume":0,"newWorktree":0,"worktreeLeftover":0,"removeWorktree":0,"artifactUrl":0,"inboxUrl":0,"gitStatus":0,"gitDiff":0,"gitBlob":0,"gitText":0,"gitStage":0,"gitCommit":0,"gitMessage":0,"gitLog":0,"gitShow":0,"gitFetch":0,"gitPull":0,"gitPush":0,"gitPushState":0,"archive":0,"archiveDelete":0,"tree":0,"treeFile":0,"treeWrite":0,"gitBranches":0,"gitCheckout":0,"gitCreateBranch":0,"gitDeleteBranch":0,"envFiles":0,"secretTargets":0,"setSecret":0,"compliance":0,"complianceFix":0,"complianceLimits":0,"complianceIgnore":0,"optIns":0,"optInChoice":0,"hostSetup":0,"hostSetupFix":0,"setupPrefs":0,"setSetupPrefs":0,"repoHealth":0,"healthIndex":0,"repoHealthScopes":0,"repoHealthRefresh":0,"hostStat":0,"screenshot":0,"ocrStatus":0,"ocrImage":0,"dictateStatus":0,"dictate":0,"setClipboard":0,"speedtest":["download","upload","debug"],"netstats":["get","reset","report"],"push":["key","subscribe","unsubscribe"],"uiUsage":["get","flush","reset"],"webBundle":["manifest","file"],"auth":["status","login","logout"],"tailnet":["peers"],"pair":["mint","redeem"],"peers":["on"],"devices":["list","revoke"]};

const SLICES = ["Sessions", "Stats", "Files", "Repos", "Git", "Tree", "RepoOps", "Host", "Net"];

/** Members of \`api\`, read as text: the 2-space-indented keys of each slice's literal, in order. */
function apiMembers() {
  const out = {};
  for (const s of SLICES) {
    const t = readFileSync(join(SRC, "webapi", "webapi" + s + ".ts"), "utf8");
    const body = t.slice(t.indexOf("= {\n") + 4, t.indexOf("\n};"));
    for (const m of body.matchAll(/^  (\w+):(\s*\{)?/gm)) out[m[1]] = m[2] ? [] : 0;
    // nested groups: collect their keys (4-space indent) under the last 2-space group key
    let cur = null;
    for (const line of body.split("\n")) {
      const g = /^  (\w+): \{$/.exec(line);
      if (g) { cur = g[1]; continue; }
      if (/^  \},?$/.test(line)) { cur = null; continue; }
      const k = cur && /^    (\w+):/.exec(line);
      if (k) out[cur].push(k[1]);
    }
  }
  return out;
}

test("api.ts: the same members, in the same order, as before the split", () => {
  const got = apiMembers();
  assert.deepEqual(got, API_KEYS);
  assert.deepEqual(Object.keys(got), Object.keys(API_KEYS));
  const facade = readFileSync(join(SRC, "api.ts"), "utf8");
  assert.deepEqual([...facade.matchAll(/^export (?:\{ (\w+)(?:, (\w+))? \}|const (\w+)|\* )/gm)].length > 0, true);
  for (const n of ["bgFetch", "bgJson", "copyText", "isOffline"]) assert.match(facade, new RegExp("\\b" + n + "\\b"));
});

test("api.ts: every member is defined in exactly one slice", () => {
  const slices = SLICES;
  const facade = readFileSync(join(SRC, "api.ts"), "utf8");
  for (const s of slices) {
    const v = s[0].toLowerCase() + s.slice(1) + "Api";
    assert.equal([...facade.matchAll(new RegExp("\\.\\.\\." + v + "\\b", "g"))].length, 1, v);
    const body = readFileSync(join(SRC, "webapi", "webapi" + s + ".ts"), "utf8");
    assert.equal([...body.matchAll(new RegExp("^export const " + v + " = \\{", "gm"))].length, 1, v);
  }
});

test("webapi/: the one nfetch lives in webapiFetch.ts; no slice calls raw fetch", () => {
  for (const s of ["Sessions", "Stats", "Files", "Repos", "Git", "Tree", "RepoOps", "Host", "Net"]) {
    const t = readFileSync(join(SRC, "webapi", "webapi" + s + ".ts"), "utf8");
    assert.ok(!/(^|[^.\w])fetch\(/m.test(t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "")) || s === "Files" || s === "Net", s);
  }
  const f = readFileSync(join(SRC, "webapi", "webapiFetch.ts"), "utf8");
  assert.equal([...f.matchAll(/^export async function nfetch\b/gm)].length, 1);
});

// ── export surfaces, read off the type checker ──────────────────────────────
function surface(rel) {
  const file = join(SRC, rel);
  const program = ts.createProgram([file], {
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true,
  });
  const checker = program.getTypeChecker();
  const mod = checker.getSymbolAtLocation(program.getSourceFile(file));
  return checker.getExportsOfModule(mod).map((s) => {
    const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
    return `${s.name}:${target.flags & ts.SymbolFlags.Value ? "value" : "type"}`;
  }).sort();
}

test("api.ts exports exactly its pinned surface", () => {
  assert.deepEqual(surface("api.ts"), [
    "ArtifactKind:type", "EnvFileInfo:type", "FileEntry:type", "PathKind:type", "SearchHit:type", "SecretResult:type",
    "SlashCommand:type", "SpeedDebug:type", "SpeedResult:type", "TreeEntry:type", "TreeFile:type", "TreeListing:type",
    "TreeWriteResult:type", "UploadError:type", "WriteTarget:type", "api:value", "bgFetch:value", "bgJson:value",
    "copyText:value", "isOffline:value",
  ]);
});

test("Gallery.tsx exports exactly its pinned surface", () => {
  assert.deepEqual(surface("Gallery.tsx"), ["Gallery:value"]);
});

// ── the gallery: server-rendered markup is byte-identical to the golden ─────
const GALLERY = join(SRC, process.env.WEBCLIENT_GALLERY_FACADE || "Gallery.tsx");
const GOLDEN = join(ROOT, "tools", "webclientpins.golden.json");

test("Gallery: the server-rendered sheet (43 cases: every tab, every viewer kind, the session picks) is byte-identical to the golden", async () => {
  const { build } = createRequire(join(ROOT, "package.json"))("esbuild");
  const dir = join(ROOT, "node_modules", ".ssr");
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "webclientpins-entry.tsx");
  writeFileSync(entry, `
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { createElement } from "react";
import { Gallery } from ${JSON.stringify(GALLERY)};
Date.prototype.toLocaleDateString = function () { return "D" + this.getTime(); };
Date.prototype.toLocaleString = function () { return "S" + this.getTime(); };
const noop = () => {};
const base = { onInsertPath: noop, onAnnotate: noop, onClose: noop };
const repos = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
const f = (relPath, extra = {}) => ({ repoId: "r1", relPath, name: relPath.split("/").pop(), size: 500000, mtime: 1700000000000, ...extra });
const files = ["x/shot.png", "x/clip.mp4", "x/report.md", "x/page.html", "x/doc.pdf", "x/song.mp3", "x/app.apk", "x/notes.txt", "x/data.csv", "x/img.jpg"];
const cases = [
  { ...base },
  { ...base, repoId: "r1" },
  { ...base, repoId: "r1", initialScope: "inbox", onSweep: noop, onSurvey: noop },
  { ...base, repoId: "r1", initialScope: "outbox", onSweep: noop },
  { ...base, repoId: "r1", initialScope: "repo", onContinueInSession: noop },
  { ...base, repos, initialScope: "all", onSurvey: noop },
  { ...base, repoId: "r1", initialAllTime: true },
  { ...base, repoId: "r1", initialNew: { since: Date.now() - 3600000, count: 3 } },
  { ...base, repoId: "r1", initialNew: { since: 1700000000000, count: 1 } },
  ...files.flatMap((p) => ["outbox", "inbox", "all"].map((sc) => ({ ...base, repoId: "r1", repos, initialScope: sc, openFile: f(p), onContinueInSession: noop, onSweep: noop }))),
  { ...base, repoId: "r1", openFile: { repoId: "r1", relPath: "a/b.png", name: "b.png" } },
  { ...base, repoId: "r1", openFile: f("a/c.png", { repoName: "Repo One", ctime: 1600000000000 }), initialScope: "inbox" },
  // *to session*: one live session is named on its button, two open a picker.
  { ...base, repoId: "r1", openFile: f("x/shot.png"), onContinueInSession: noop, sessionsIn: () => [{ id: "s1", label: "main", onScreen: true }] },
  { ...base, repoId: "r1", openFile: f("x/shot.png"), onContinueInSession: noop, sessionsIn: () => [{ id: "s1", label: "main", onScreen: true }, { id: "s2", label: "fix-x", onScreen: false }] },
];
export default cases.map((p) => renderToString(createElement(Gallery, p)) + "\\n@@\\n" + renderToStaticMarkup(createElement(Gallery, p)));
`);
  const out = join(dir, "webclientpins-bundle.mjs");
  await build({
    entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: out, jsx: "automatic", logLevel: "error",
    loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl" },
    external: ["react", "react-dom", "lucide-react"], nodePaths: [join(ROOT, "node_modules")],
    define: { "import.meta.env": "{}", __BUILD_ID__: '"TEST"' },
  });
  const htmls = (await import(`${pathToFileURL(out).href}?t=${Date.now()}`)).default;
  const digests = htmls.map((h) => createHash("sha256").update(h).digest("hex").slice(0, 16));
  assert.ok(htmls.every((h) => h.startsWith('<div class="sheet">')), "the sheet did not render");
  if (process.env.REGOLDEN) { const g = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, "utf8")) : {}; writeFileSync(GOLDEN, JSON.stringify({ ...g, gallery: digests }, null, 1) + "\n"); return; }
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
  assert.deepEqual(digests, golden.gallery);
});

function galleryText() {
  const dir = join(SRC, "gallery");
  const files = [join(SRC, "Gallery.tsx"), ...(existsSync(dir) ? readdirSync(dir).filter((f) => /\.tsx?$/.test(f)).map((f) => join(dir, f)) : [])];
  return files.map((f) => readFileSync(f, "utf8")).join("\n");
}
const count = (text, re) => (text.match(re) ?? []).length;

test("Gallery: one download button, no native modal, no raw anchor download, tracked actions once", () => {
  const t = galleryText();
  assert.equal(count(t, /(?<!`)<a\b[^>]*\bdownload\b/g), 0);
  assert.equal(count(t, /<DownloadButton\b/g), 3);
  assert.equal(count(t, /window\.(confirm|prompt)\s*\(/g), 0);
  assert.equal(count(t, /new WebSocket\(/g), 0);
  for (const id of ["gallery.delete", "gallery.more", "gallery.fullres", "gallery.annotate", "gallery.download", "gallery.toSession", "gallery.toNewSession"]) {
    assert.equal(count(t, new RegExp('"action:' + id.replace(".", "\\.") + '"', "g")), 1, id);
  }
  assert.equal(count(t, /useBackStep\(/g), 1);
  assert.equal(count(t, /pulls\.subscribe\(/g), 1);
});

test("Gallery: the hooks run in the original order (effect ORDER is behaviour)", () => {
  const t = readFileSync(join(SRC, "gallery", "useGallery.tsx"), "utf8");
  const order = ["useGalleryOpen(", "pulls.subscribe(", "useGalleryListing(", "useGalleryViewer(", "pulls.objectUrl(", "addEventListener(\"keydown\""];
  const at = order.map((k) => t.indexOf(k));
  assert.ok(at.every((n) => n >= 0), String(at));
  assert.deepEqual([...at].sort((a, b) => a - b), at);
});

// ── repoHealthWords: every export, over a fixed battery of inputs, answers as before ──
const pool = [undefined, null, 0, 1, 3, 57, 1329, -1, 2.5, 0.69, 1e6, "", "abc", "2026-06-18", "2026-13-40", "a1b2c3d4e5f6", "setup", "series", "src/web", true, false,
  { rows: 5 }, { rows: 0, days: 3, preregVersion: "v2" }, ["w1", "w2"], [], [{ version: "v1", rows: 3 }, { version: "v2", rows: 9 }],
  { behind: 4, lastSha: "abcdef123", headSha: "fedcba987", lastDay: "2026-06-01", commits: 12, absent: "no data", points: 3, readings: 1, minToDraw: 2, rank: 0.89, n: 90, startedAt: 1000, note: "n", slope: "rising", label: "L", v: 3 },
  { rank: 0.5, n: 30, slope: "falling", windowStart: "2026-05-01" }, { staleRows: 3, error: "x" }, { engine: "e", packs: [{ name: "p", files: 3 }, { name: "q" }], subs: 4, commits: 7 }];
function battery(m) {
  const out = {};
  for (const [name, v] of Object.entries(m)) {
    if (typeof v === "function") {
      const res = [];
      const ar = Math.min(v.length, 3);
      const combos = ar === 0 ? [[]] : ar === 1 ? pool.map((a) => [a]) : ar === 2 ? pool.flatMap((a) => pool.slice(0, 12).map((b) => [a, b])) : pool.slice(0, 14).flatMap((a) => pool.slice(0, 10).flatMap((b) => pool.slice(0, 8).map((c) => [a, b, c])));
      for (const args of combos) { try { res.push(JSON.stringify(v(...args)) ?? "u"); } catch (e) { res.push("throw:" + e.constructor.name); } }
      out[name] = res;
    } else out[name] = JSON.stringify(v);
  }
  return out;
}

const WORDS = join(SRC, process.env.WEBCLIENT_WORDS_FACADE || "repoHealthWords.ts");

test("repoHealthWords.ts exports exactly its pinned surface (the five helpers stay private)", async () => {
  const names = surface("repoHealthWords.ts");
  // 49 at the split; the repo's own readings (whose each reading is) and its
  // say over the central ones (repoHealthWordsCentral.ts) added the rest; the
  // redesign's new words (plotAxisModeWords, notesSummaryWords, middleEllipsis) took it to 62.
  assert.equal(names.length, 62);
  const m = await import(pathToFileURL(WORDS).href);
  assert.deepEqual(Object.keys(m).sort(), names.filter((n) => n.endsWith(":value")).map((n) => n.split(":")[0]).sort());
  for (const priv of ["nf", "ordinal", "pctOf", "spanWords", "commitWords"]) assert.ok(!(priv in m), priv);
});

test("repoHealthWords: every export answers the fixed battery exactly as when last regoldened (golden)", async () => {
  const m = await import(pathToFileURL(WORDS).href);
  const digest = createHash("sha256").update(JSON.stringify(battery(m))).digest("hex");
  if (process.env.REGOLDEN) {
    const g = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, "utf8")) : {};
    writeFileSync(GOLDEN, JSON.stringify({ ...g, words: digest }, null, 1) + "\n");
    return;
  }
  assert.equal(digest, JSON.parse(readFileSync(GOLDEN, "utf8")).words);
});

test("repoHealthWords/: pure — slices import only each other; no status colour token anywhere in them", () => {
  const dir = join(SRC, "repoHealthWords");
  for (const f of readdirSync(dir)) {
    const t = readFileSync(join(dir, f), "utf8");
    // A TYPE import from the wire is erased at run time, so it keeps a slice pure.
    for (const m of t.matchAll(/^import (type )?.* from "([^"]+)"/gm)) {
      if (m[1] && m[2] === "@waterplane/shared") continue;
      assert.match(m[2], /^\.\/repoHealthWords\w+\.ts$/, `${f}: ${m[0]}`);
    }
    for (const token of ["--warn", "--dead", "--limit", "--ok"]) assert.ok(!t.includes(token), );
  }
});
