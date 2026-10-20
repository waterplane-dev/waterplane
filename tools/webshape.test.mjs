/**
 * The web client's SHAPE: `App.tsx` only shrinks, and every feature folder is
 * the self-contained thing the registry says it is.
 *
 * ── Why this is a test and not a sentence ───────────────────────────────────
 *
 * `claudemd.test.mjs`'s argument, one file over. `App.tsx` reached 17k lines
 * because each edit added a few, every one worth writing and none the one that
 * made it too big — and every feature in it meant every change conflicted with
 * every other. The move into `features/` only pays while it is one-way, so the
 * line count is a RATCHET: it may go down, and the number here goes down with
 * it; it may not go up. The rest pins what makes a folder a feature — a
 * manifest named for it, a README saying what it is, one registry entry, and
 * sheet ids the route stack already knows.
 *
 * And it pins what makes a MOVE real rather than a copy: once a feature
 * handles a frame or owns a sheet, App no longer does (a `case` left behind
 * runs both, in an order nobody chose); `bindCore` runs before App's early
 * return and no hook runs after it; every file in a feature folder has one of
 * the prescribed names, so opening any feature is opening the same shape.
 *
 * All of it is read as TEXT: no build, no import, no DOM. Reasoning and the
 * step-by-step for adding a feature: docs/notes/web-architecture.md.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { warnLongFiles } from "./longfiles.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "packages", "web", "src");
const FEATURES = join(SRC, "features");

// Early warning (never fails): web files past 800 lines, under whatever cap applies.
warnLongFiles("web", SRC);

/**
 * The most lines `App.tsx` may have. **Lower it when you move code out**, in
 * the same commit — that is the ratchet. Raising it is a decision about the
 * file every change conflicts in, not a way to make the check pass: the new
 * code belongs in a feature folder.
 */
const MAX_APP_LINES = 394;

/** A feature file is a slice, never a new App. The same number eslint's
 *  `max-lines` warns at — here it fails. */
const MAX_FEATURE_FILE_LINES = 900;

/** A core module is one of the things there must be ONE of — never the next
 *  App either. Same number as a feature file. */
const MAX_CORE_FILE_LINES = 900;

/** The folders `core/` may have: one per thing there is one of. A module that
 *  is none of these is a single file at `core/`'s top, or a feature. */
const CORE_DIRS = ["conn", "route", "term", "queue", "launch", "compose", "send", "sessions", "launcher", "session", "settings", "layout"];

/** A README shorter than this cannot say what the feature is, what it owns
 *  and what it reads from the core. */
const MIN_README_CHARS = 300;

const lines = (text) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

function featureDirs() {
  if (!existsSync(FEATURES)) return [];
  return readdirSync(FEATURES, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

function featureFiles() {
  if (!existsSync(FEATURES)) return [];
  return readdirSync(FEATURES, { recursive: true })
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => ({ rel: f, text: readFileSync(join(FEATURES, f), "utf8") }));
}

test("App.tsx does not grow", () => {
  const n = lines(readFileSync(join(SRC, "App.tsx"), "utf8"));
  assert.ok(
    n <= MAX_APP_LINES,
    `App.tsx is ${n} lines, over the ${MAX_APP_LINES} ratchet by ${n - MAX_APP_LINES}.\n` +
    `New behaviour belongs in packages/web/src/features/<name>/, reached through the SDK —\n` +
    `see docs/notes/web-architecture.md, "Adding a feature". Raise MAX_APP_LINES in\n` +
    `tools/webshape.test.mjs only as a decision, never to make this pass.`,
  );
  if (n < MAX_APP_LINES - 50) {
    // Not a failure: a reminder that the ratchet only holds if it follows.
    console.log(`# App.tsx is ${n} lines — lower MAX_APP_LINES in tools/webshape.test.mjs to lock that in`);
  }
});

test("every feature folder has a manifest named for it and a README", () => {
  const bad = [];
  for (const d of featureDirs()) {
    const index = join(FEATURES, d, "index.ts");
    if (!existsSync(index)) { bad.push(`${d}: no index.ts`); continue; }
    const src = readFileSync(index, "utf8");
    if (!/export const manifest\b/.test(src)) bad.push(`${d}: index.ts does not \`export const manifest\``);
    const id = /export const manifest\b[\s\S]*?\bid:\s*"([^"]+)"/.exec(src)?.[1];
    if (id !== d) bad.push(`${d}: manifest id is ${id ? `"${id}"` : "not a literal"}, must be "${d}"`);
    const readme = join(FEATURES, d, "README.md");
    const size = existsSync(readme) ? readFileSync(readme, "utf8").trim().length : 0;
    if (size < MIN_README_CHARS) bad.push(`${d}: README.md is ${size} chars, needs ${MIN_README_CHARS}+ (what it is, what it owns, what it reads from core)`);
  }
  assert.deepEqual(bad, [], `A feature folder is the unit a contributor opens first; these are incomplete.`);
});

test("the registry lists every feature exactly once, and nothing else", () => {
  const reg = readFileSync(join(FEATURES, "registry.ts"), "utf8");
  const imported = [...reg.matchAll(/from\s+"\.\/([^/"]+)(?:\/index(?:\.ts)?)?"/g)].map((m) => m[1]);
  const dirs = featureDirs();
  const problems = [];
  for (const d of dirs) {
    const n = imported.filter((x) => x === d).length;
    if (n !== 1) problems.push(`${d}: imported ${n} times by registry.ts`);
  }
  for (const x of imported) if (!dirs.includes(x)) problems.push(`registry.ts imports ./${x}, which is not a feature folder`);
  assert.deepEqual(
    problems, [],
    `features/registry.ts must import each features/<name>/index.ts once, as\n` +
    `  import { manifest as <name> } from "./<name>";\n` +
    `and list it in FEATURES. An unlisted feature's sheets, handlers and boot never run.`,
  );
});

test("every feature sheet is an Overlay the route stack knows, persisted as the route says", () => {
  const routing = readFileSync(join(SRC, "routing.ts"), "utf8");
  const union = /export type Overlay\s*=([^;]+);/.exec(routing)?.[1] ?? "";
  const overlays = new Set([...union.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  const persistedSrc = /export const PERSISTED_OVERLAYS[^[]*\[([^\]]*)\]/.exec(routing)?.[1] ?? "";
  const persisted = new Set([...persistedSrc.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  assert.ok(overlays.size > 10 && persisted.size > 0, "could not read Overlay / PERSISTED_OVERLAYS out of routing.ts — did they move?");
  const bad = [];
  for (const f of featureFiles()) {
    const decls = [...f.text.matchAll(/\bpersisted:/g)].length;
    const defs = [...f.text.matchAll(/\bid:\s*"([^"]+)"\s*,\s*persisted:\s*(true|false)\b/g)];
    if (defs.length !== decls) bad.push(`${f.rel}: write a SheetDef as \`{ id: "<overlay>", persisted: true|false, … }\`, literally, so this can read it`);
    for (const [, id, p] of defs) {
      if (!overlays.has(id)) bad.push(`${f.rel}: sheet "${id}" is not in routing.ts's Overlay union`);
      else if ((p === "true") !== persisted.has(id)) bad.push(`${f.rel}: sheet "${id}" says persisted: ${p}, PERSISTED_OVERLAYS says ${persisted.has(id)}`);
    }
  }
  assert.deepEqual(bad, [], `Back, the hash and a reload all key on routing.ts — a sheet id it does not know is a screen Back cannot leave.`);
});

test(`no feature file is over ${MAX_FEATURE_FILE_LINES} lines`, () => {
  const fat = featureFiles().map((f) => ({ rel: f.rel, n: lines(f.text) })).filter((f) => f.n > MAX_FEATURE_FILE_LINES);
  assert.deepEqual(
    fat.map((f) => `${f.rel}: ${f.n}`), [],
    `A feature file that big is the next App.tsx. Split it inside its folder.`,
  );
});

const CORE = join(SRC, "core");

test(`no core file is over ${MAX_CORE_FILE_LINES} lines`, () => {
  const files = existsSync(CORE) ? readdirSync(CORE, { recursive: true }).filter((f) => /\.(ts|tsx)$/.test(f)) : [];
  const fat = files.map((f) => ({ rel: f, n: lines(readFileSync(join(CORE, f), "utf8")) })).filter((f) => f.n > MAX_CORE_FILE_LINES);
  assert.deepEqual(
    fat.map((f) => `core/${f.rel}: ${f.n}`), [],
    `A core file that big is App.tsx moved one folder down. Split it inside its core/<dir>.`,
  );
});

test("every core/<dir> is one of the core modules", () => {
  const dirs = existsSync(CORE) ? readdirSync(CORE, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
  assert.deepEqual(
    dirs.filter((d) => !CORE_DIRS.includes(d)).sort(), [],
    `core/ holds the things there must be ONE of (${CORE_DIRS.join(", ")}). A screen a feature can\n` +
    `own alone is a features/<name>/ folder; a new core module is a decision — add it to CORE_DIRS\n` +
    `in tools/webshape.test.mjs and the core modules table in docs/notes/web-architecture.md.`,
  );
});

// ── Reading a manifest as text ───────────────────────────────────────────────

/** `src` with comments, strings and template literals blanked to spaces (same
 *  length, so indices still line up) — braces inside them must not count. */
function blank(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { const j = src.indexOf("\n", i); const e = j < 0 ? src.length : j; out += " ".repeat(e - i); i = e; continue; }
    if (c === "/" && d === "*") { const j = src.indexOf("*/", i + 2); const e = j < 0 ? src.length : j + 2; out += src.slice(i, e).replace(/[^\n]/g, " "); i = e; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      // Keep the quotes so a `"key":` is still recognisable; blank the inside.
      out += c + src.slice(i + 1, j).replace(/[^\n]/g, " ") + c; i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}

/** The `[start, end)` span of the bracketed value after `prop:` (the first
 *  one), where the opener is `open`; null when `prop:` is absent or its value
 *  does not start with that bracket. */
function valueSpan(bl, prop, open) {
  const m = new RegExp(`\\b${prop}\\s*:\\s*`).exec(bl);
  if (!m) return null;
  const at = m.index + m[0].length;
  if (bl[at] !== open) return { at, literal: false };
  let depth = 0;
  for (let i = at; i < bl.length; i++) {
    if ("([{".includes(bl[i])) depth++;
    else if (")]}".includes(bl[i]) && --depth === 0) return { at, start: at + 1, end: i, literal: true };
  }
  return null;
}

/** Split `bl.slice(start, end)` at its depth-0 commas. */
function topLevel(bl, start, end) {
  const parts = [];
  let depth = 0, from = start;
  for (let i = start; i < end; i++) {
    if ("([{".includes(bl[i])) depth++;
    else if (")]}".includes(bl[i])) depth--;
    else if (bl[i] === "," && depth === 0) { parts.push([from, i]); from = i + 1; }
  }
  parts.push([from, end]);
  // Start each part at its first CODE character, past a leading comment.
  return parts.filter(([a, b]) => bl.slice(a, b).trim()).map(([a, b]) => [a + bl.slice(a, b).search(/\S/), b]);
}

/** Each feature's `index.ts`: the frame types its `messages` handles and its
 *  sheets, as the ORIGINAL text of each array element. */
function manifests() {
  return featureDirs().filter((d) => existsSync(join(FEATURES, d, "index.ts"))).map((d) => {
    const src = readFileSync(join(FEATURES, d, "index.ts"), "utf8");
    const bl = blank(src);
    const msgs = valueSpan(bl, "messages", "{");
    const messages = msgs?.literal
      ? topLevel(bl, msgs.start, msgs.end).map(([a, b]) => /^\s*(?:"([^"]*)"|([A-Za-z_$][\w$]*))\s*[:(]/.exec(src.slice(a, b))).filter(Boolean).map((m) => m[1] ?? m[2])
      : [];
    const sh = valueSpan(bl, "sheets", "[");
    const sheets = sh === null ? null : sh.literal ? topLevel(bl, sh.start, sh.end).map(([a, b]) => src.slice(a, b).trim()) : "non-literal";
    return { name: d, src, messages, sheets };
  });
}

/** App.tsx's `function App()` body, blanked: from its signature to the file's
 *  first column-0 `}` after it. */
function appBody() {
  const src = readFileSync(join(SRC, "App.tsx"), "utf8");
  const bl = blank(src);
  const start = /^export function App\(\)/m.exec(bl)?.index;
  assert.ok(start !== undefined, "could not find `export function App()` in App.tsx — did it move?");
  const close = /^\}/m.exec(bl.slice(start));
  const end = close ? start + close.index : bl.length;
  return { src, bl, start, end };
}

// ── What a move must take with it ─────────────────────────────────────────────

test("App.tsx has no `case` for a frame a feature's `messages` handles (welcome excepted)", () => {
  // App's frame switch lives in `core/conn/useHostFrames.ts` (docs/notes/app-architecture.md);
  // App's own body is read too, so a case put back there is still seen.
  const { bl, src } = appBody();
  const router = readFileSync(join(SRC, "core", "conn", "useHostFrames.ts"), "utf8");
  // `bl` blanks string contents, so read the case labels off the source at the
  // positions the blanked text says are code.
  const labels = (b, s) => [...b.matchAll(/\bcase\s+"/g)].map((m) => /^"([^"]*)"/.exec(s.slice(m.index + m[0].length - 1))?.[1]);
  const cases = new Set([...labels(bl, src), ...labels(blank(router), router)]);
  assert.ok(cases.has("session.list"), "could not read the frame switch's cases — did it move?");
  const bad = [];
  for (const f of manifests()) {
    for (const t of f.messages) {
      // Every feature may re-sync on a reconnect; App keeps its own welcome.
      if (t === "welcome") continue;
      if (cases.has(t)) bad.push(`"${t}": handled by features/${f.name} AND by a \`case "${t}":\` in App.tsx`);
    }
  }
  assert.deepEqual(
    bad, [],
    `Moving a frame into a feature is DELETING its case in App's switch. Left behind,\n` +
    `both run on every frame — App first, then the feature — and a fix to one is a\n` +
    `fix to half. Delete the App case (docs/notes/web-architecture.md, "Adding a feature").`,
  );
});

test("App's overlayViews has no entry for a sheet a feature owns", () => {
  // App's table lives in `core/route/overlayViews.tsx` (docs/notes/app-architecture.md).
  const src = readFileSync(join(SRC, "core", "route", "overlayViews.tsx"), "utf8");
  const bl = blank(src);
  const at = /\bconst overlayViews\b.*?=\s*(?=\{)/.exec(bl);
  assert.ok(at, "could not find `const overlayViews` in core/route/overlayViews.tsx — did it move?");
  const open = at.index + at[0].length;
  assert.equal(bl[open], "{", "overlayViews is not an object literal");
  let depth = 0, close = -1;
  for (let i = open; i < bl.length; i++) {
    if ("([{".includes(bl[i])) depth++;
    else if (")]}".includes(bl[i]) && --depth === 0) { close = i; break; }
  }
  const keys = new Set(topLevel(bl, open + 1, close)
    .map(([a, b]) => /^\s*(?:"([^"]*)"|([A-Za-z_$][\w$]*))\s*:/.exec(src.slice(a, b)))
    .filter(Boolean).map((m) => m[1] ?? m[2]));
  const bad = [];
  for (const f of manifests()) {
    if (!Array.isArray(f.sheets)) continue;
    for (const el of f.sheets) {
      const id = /\bid:\s*"([^"]+)"/.exec(el)?.[1];
      if (id && keys.has(id)) bad.push(`"${id}": owned by features/${f.name} AND listed in App's overlayViews`);
    }
  }
  assert.deepEqual(
    bad, [],
    `\`...featureSheets()\` comes first in overlayViews, so an App entry with the same\n` +
    `id silently WINS and the feature's sheet never renders. Delete App's entry.`,
  );
});

test("bindCore runs before App's authGate return, and no hook runs after it", () => {
  const { bl, start, end } = appBody();
  const body = bl.slice(start, end);
  const bind = body.indexOf("bindCore(");
  const gate = /\bif\s*\(\s*authGate\s*\)\s*return\b/.exec(body);
  assert.ok(gate, "could not find `if (authGate) return` in App() — did the gate move?");
  assert.ok(bind >= 0 && bind < gate.index,
    `bindCore( must be called in App() BEFORE \`if (authGate) return\`: a feature that\n` +
    `renders while the gate is up (AuthGate itself) calls core(), and an unbound core throws.`);
  const after = body.slice(gate.index);
  const hooks = [...after.matchAll(/(?<![\w$.])use[A-Z][\w$]*\(/g)].map((m) => {
    const line = bl.slice(0, start + gate.index + m.index).split("\n").length;
    return `App.tsx:${line}: ${m[0]}`;
  });
  assert.deepEqual(
    hooks, [],
    `A hook after App's early \`authGate\` return runs on some renders and not others —\n` +
    `React's rules of hooks, broken in the way that only shows when the gate flips.\n` +
    `Move it above the return (and above bindCore's comment block).`,
  );
});

test("every feature SheetDef is an object literal with a literal id and persisted", () => {
  const bad = [];
  for (const f of manifests()) {
    if (f.sheets === null) continue;
    if (f.sheets === "non-literal") { bad.push(`${f.name}/index.ts: \`sheets:\` is not an array literal`); continue; }
    f.sheets.forEach((el, i) => {
      const lit = el.startsWith("{") && /\bid:\s*"[^"]+"/.test(el) && /\bpersisted:\s*(true|false)\b/.test(el);
      if (!lit) bad.push(`${f.name}/index.ts: sheets[${i}] is \`${el.split("\n")[0].slice(0, 60)}…\``);
    });
  }
  assert.deepEqual(
    bad, [],
    `Write each SheetDef inline as \`{ id: "<overlay>", persisted: true|false, render, … }\`.\n` +
    `A sheet built by a helper, spread from a constant or mapped from a list is one this\n` +
    `test cannot read — so its id is never checked against routing.ts's Overlay union\n` +
    `and PERSISTED_OVERLAYS, and Back/reload can strand it.`,
  );
});

// ── One shape per feature folder ──────────────────────────────────────────────

/**
 * The names a file in `features/<x>/` may have. The point is that opening ANY
 * feature is opening the same shape: the manifest, the stores, the actions,
 * the pure logic and its test, the sheet, the README — nothing to learn twice.
 */
const FEATURE_FILE_NAMES = [
  /^index\.ts$/,          // manifest + public API only, no logic
  /^store\.ts$/,          // createStore stores only, and their read hooks
  /^actions\.ts$/,        // functions that write stores / send frames
  /^[a-z][A-Za-z0-9]*Actions\.ts$/, // a slice of actions.ts, re-exported by it (actions.ts stays the import point)
  /^logic\.ts$/,          // pure
  /^README\.md$/,
  /^[A-Z][A-Za-z0-9]*Sheet\.tsx$/, // the sheet component
  /^[A-Z][A-Za-z0-9]*\.tsx$/,      // any other component
  /^[A-Za-z0-9]+\.test\.mjs$/,     // logic.test.mjs, and any other pure test
];

test("every file in a feature folder has a prescribed name", () => {
  const bad = [];
  for (const d of featureDirs()) {
    for (const e of readdirSync(join(FEATURES, d), { withFileTypes: true })) {
      if (e.isDirectory()) { bad.push(`${d}/${e.name}/: no subfolders — a feature is one flat folder`); continue; }
      if (!FEATURE_FILE_NAMES.some((re) => re.test(e.name))) bad.push(`${d}/${e.name}`);
    }
  }
  assert.deepEqual(
    bad, [],
    `A feature folder holds: index.ts (manifest + public API), store.ts (stores),\n` +
    `actions.ts (writes stores / sends frames; <name>Actions.ts slices re-exported by it), logic.ts (pure) + logic.test.mjs,\n` +
    `<Name>Sheet.tsx, other <Name>.tsx components, README.md. Rename the file to\n` +
    `the role it plays (docs/notes/web-architecture.md, "The feature layout").`,
  );
});

// ── In-repo extensions (packages/extensions/<id>/web) ────────────────────────
//
// The same contract as a feature folder, one import each in registry.ts (the EXTENSIONS block). What
// differs: the folder is named for the plugin, so a sheet id is `feature:<id>/<name>` (the Overlay
// union takes that template, `routing.ts`'s `featureSheetId`) and is NEVER persisted.

const EXT = join(ROOT, "packages", "extensions");
const extWebDirs = () => (existsSync(EXT)
  ? readdirSync(EXT, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(EXT, e.name, "web", "index.ts"))).map((e) => e.name).sort()
  : []);

test("every extension web half exports a manifest named for its folder, found by the registry's glob, colliding with no feature", () => {
  const reg = readFileSync(join(FEATURES, "registry.ts"), "utf8");
  const bad = [];
  for (const d of extWebDirs()) {
    const src = readFileSync(join(EXT, d, "web", "index.ts"), "utf8");
    if (!/export const manifest\b/.test(src)) bad.push(`${d}: web/index.ts does not \`export const manifest\``);
    const id = /export const manifest\b[\s\S]*?\bid:\s*"([^"]+)"/.exec(src)?.[1];
    if (id !== d) bad.push(`${d}: manifest id is ${id ? `"${id}"` : "not a literal"}, must be "${d}"`);
    // Globbed, not imported one by one: the glob must be there, once, and nothing may ALSO import
    // the extension by name (twice in the list, and an edit the private ones cannot have).
    const n = [...reg.matchAll(new RegExp(`from\\s+"[./]*extensions/${d}/web/index(?:\\.ts)?"`, "g"))].length;
    if (n !== 0) bad.push(`${d}: imported by name in registry.ts — extensions are globbed, never listed`);
    if (featureDirs().includes(d)) bad.push(`${d}: also a folder under features/ — one id, one owner`);
  }
  const globs = [...reg.matchAll(/import\.meta\.glob<[^>]*>\("\.\.\/\.\.\/\.\.\/extensions\/\*\/web\/index\.ts", \{ eager: true \}\)/g)].length;
  if (globs !== 1) bad.push(`registry.ts must glob every extension web half once, eagerly (found ${globs})`);
  if (!/\.\.\.EXTENSIONS,\s*\];/.test(reg)) bad.push("registry.ts must spread the globbed EXTENSIONS last in FEATURES");
  assert.deepEqual(bad, [], `An extension's web half is found by features/registry.ts's EXTENSIONS glob:\n  import.meta.glob<{ manifest: FeatureManifest }>("../../../extensions/*/web/index.ts", { eager: true })`);
});

/**
 * The ONE exception to "an extension's sheets are feature:<id>/<name>": an extension may adopt a core
 * Overlay id that already has doors, deep links (`#o=<id>`) and usage counters — listed here by literal,
 * and then `persisted` must equal membership in PERSISTED_OVERLAYS. (token-stats: `tokens`.)
 */
const ADOPTED_CORE_SHEETS = { "token-stats": ["tokens"] };

test("an extension's sheets are feature:<id>/<name> and never persisted, except the adopted core ids", () => {
  const routingSrc = readFileSync(join(SRC, "routing.ts"), "utf8");
  const persistedIds = [...(/export const PERSISTED_OVERLAYS[^[]*\[([^\]]*)\]/.exec(routingSrc)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const bad = [];
  for (const d of extWebDirs()) {
    const files = readdirSync(join(EXT, d, "web"), { recursive: true }).filter((f) => /\.(ts|tsx)$/.test(f));
    for (const f of files) {
      const text = readFileSync(join(EXT, d, "web", f), "utf8");
      const decls = [...text.matchAll(/\bpersisted:\s*(?:true|false)\b/g)].length;
      const defs = [...text.matchAll(/\bid:\s*(?:"([^"]+)"|featureSheetId\("([^"]+)",\s*"([^"]+)"\))\s*,\s*persisted:\s*(true|false)\b/g)];
      if (defs.length !== decls) bad.push(`${d}/web/${f}: write a SheetDef as \`{ id: featureSheetId("${d}", "<name>"), persisted: false, … }\`, literally`);
      for (const [, lit, feat, sheet, p] of defs) {
        const id = lit ?? `feature:${feat}/${sheet}`;
        if (lit && (ADOPTED_CORE_SHEETS[d] ?? []).includes(lit)) {
          if (String(persistedIds.includes(lit)) !== p) bad.push(`${d}/web/${f}: adopted core sheet "${lit}" says persisted: ${p}, PERSISTED_OVERLAYS says ${persistedIds.includes(lit)}`);
          continue;
        }
        if (!new RegExp(`^feature:${d}/[a-z][a-z0-9-]{0,39}$`).test(id)) bad.push(`${d}/web/${f}: sheet "${id}" is not feature:${d}/<name>`);
        if (p !== "false") bad.push(`${d}/web/${f}: sheet "${id}" says persisted: ${p} — a feature: sheet is never persisted`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test("the Overlay union takes feature:<id>/<sheet> and PERSISTED_OVERLAYS never does", () => {
  const routing = readFileSync(join(SRC, "routing.ts"), "utf8");
  assert.match(routing, /export type Overlay\s*=[^;]*\|\s*FeatureSheetId;/);
  assert.match(routing, /export type FeatureSheetId = `feature:\$\{string\}\/\$\{string\}`;/);
  const persistedSrc = /export const PERSISTED_OVERLAYS[^[]*\[([^\]]*)\]/.exec(routing)?.[1] ?? "";
  assert.ok(!/feature:/.test(persistedSrc));
});

// ── The token statistics screen's move (docs/notes/token-stats-architecture.md) ─────────────────

/** An extension web file is held to the same cap as a feature file. */
const MAX_EXT_FILE_LINES = 900;

const extWebFiles = () => extWebDirs().flatMap((d) =>
  readdirSync(join(EXT, d, "web"), { recursive: true })
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => ({ rel: `${d}/web/${f}`, name: f.split("/").pop(), text: readFileSync(join(EXT, d, "web", f), "utf8") })));

test(`no extension web file is over ${MAX_EXT_FILE_LINES} lines`, () => {
  const fat = extWebFiles().map((f) => ({ rel: f.rel, n: lines(f.text) })).filter((f) => f.n > MAX_EXT_FILE_LINES);
  assert.deepEqual(fat.map((f) => `${f.rel}: ${f.n}`), [], `An extension file that big is the next App.tsx. Split it inside its web/ folder.`);
});

test("each sheet id is declared once across features and extensions", () => {
  // createSheetTable's Map lets the LAST declaration win silently, so a duplicate is a sheet that
  // quietly renders somebody else's screen.
  const seen = new Map();
  const add = (id, where) => seen.set(id, [...(seen.get(id) ?? []), where]);
  const re = /\bid:\s*(?:"([^"]+)"|featureSheetId\("([^"]+)",\s*"([^"]+)"\))\s*,\s*persisted:\s*(?:true|false)\b/g;
  for (const f of featureFiles()) for (const m of f.text.matchAll(re)) add(m[1] ?? `feature:${m[2]}/${m[3]}`, `features/${f.rel}`);
  for (const f of extWebFiles()) for (const m of f.text.matchAll(re)) add(m[1] ?? `feature:${m[2]}/${m[3]}`, `extensions/${f.rel}`);
  assert.ok(seen.size > 10, "found almost no SheetDefs — did the literal shape change?");
  const dup = [...seen].filter(([, w]) => w.length > 1).map(([id, w]) => `${id}: ${w.join(", ")}`);
  assert.deepEqual(dup, []);
});

// ── The backlog sheet's split (docs/notes/backlog-architecture.md) ───────────
//
// `Backlog.tsx` and `backlogFilter.ts` are flat modules (the backlog FEATURE
// wraps them), so they are not under the feature caps above. Each is cut into
// a folder of its own beside it; the facade keeps its path, so no importer
// changes. The facades are RATCHETS (lower the number in the commit that moves
// code out), and every file in the two folders is LISTED here exactly once with
// its own cap — a new file is a line in this table, not a file nobody counts.

/** The most lines each facade may have. Lower it when you move code out. */
const BACKLOG_FACADES = {
  "Backlog.tsx": 72,
  "backlogFilter.ts": 59,
};

/** Every file in the split folders, by path under `packages/web/src`, and its
 *  cap. None may exceed 900 (`MAX_FEATURE_FILE_LINES`); aim ≤ 500. */
const BACKLOG_SPLIT_FILES = {
  "backlog/BacklogBody.tsx": 60,
  "backlog/BacklogFilterBar.tsx": 160, // +one kit FilterChip row per axis, and the archived chip
  "backlog/BacklogList.tsx": 75,
  "backlog/BacklogRow.tsx": 205,
  "backlog/BulkBars.tsx": 230, // +the Bar helper (note, then one link on the chips' edge)
  "backlog/PickBars.tsx": 150, // the re-time/name row, above the list in both orders, + one pick per clock, + the slot check
  "backlog/Notices.tsx": 115, // +the auto-off sentence behind its Explain
  "backlog/RepoBar.tsx": 120,
  "backlog/RowActions.tsx": 185,
  "backlog/RowChips.tsx": 300, // +a set cap is a tap to edit (R-automation-044)
  "backlog/RowEditor.tsx": 95,
  "backlog/RowBudgetEdit.tsx": 40,
  "backlog/RowFlagChoice.tsx": 25,
  "backlog/RowNotes.tsx": 310, // +the flag-when-done tick under the close choice, +the budget… chip and its editor
  "backlog/backlogLabels.ts": 125,
  "backlog/backlogTypes.ts": 435,
  "backlog/useBacklogCuts.ts": 470,
  "backlog/useBacklogDraft.ts": 30,
  "backlog/useBacklogDrag.ts": 68,
  "backlog/useBacklogEdit.ts": 90,
  "backlog/useBacklogFilters.ts": 125,
  "backlog/useBacklogUi.ts": 70,
  "backlogFilter/rowBuckets.ts": 100,
  "backlogFilter/clockGroups.ts": 200,
  "backlogFilter/cutCounts.ts": 330, // +drawnChips (a chip that cuts nothing is not drawn) and the pools it reads
  "backlogFilter/dropClock.ts": 150,
  "backlogFilter/rowFilter.ts": 130,
  "backlogFilter/titleWords.ts": 175,
  "backlogFilter/retimeMany.ts": 110, // +clockPicks: one clock's movable rows as one tap
  "backlogFilter/rowWords.ts": 120, // +holderOffer (the serial row's way to the session it waits behind)
  "backlogFilter/runAgain.ts": 355,
  "backlogFilter/scheduleWords.ts": 60,
};
const BACKLOG_SPLIT_DIRS = ["backlog", "backlogFilter"];

test("the backlog facades do not grow", () => {
  const over = [];
  for (const [rel, max] of Object.entries(BACKLOG_FACADES)) {
    const n = lines(readFileSync(join(SRC, rel), "utf8"));
    if (n > max) over.push(`${rel} is ${n} lines, over its ${max} ratchet by ${n - max}`);
    else if (n < max - 50) console.log(`# ${rel} is ${n} lines — lower BACKLOG_FACADES["${rel}"] in tools/webshape.test.mjs to lock that in`);
  }
  assert.deepEqual(over, [], `New backlog code belongs in backlog/ or backlogFilter/ — docs/notes/backlog-architecture.md.`);
});

test("every file in backlog/ and backlogFilter/ is listed once, under its cap", () => {
  const onDisk = BACKLOG_SPLIT_DIRS.flatMap((d) => (existsSync(join(SRC, d))
    ? readdirSync(join(SRC, d), { recursive: true }).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => `${d}/${f.split("\\").join("/")}`)
    : [])).sort();
  const listed = Object.keys(BACKLOG_SPLIT_FILES).sort();
  assert.deepEqual(onDisk, listed, `List each new file in BACKLOG_SPLIT_FILES (and drop a deleted one).`);
  const bad = [];
  for (const [rel, max] of Object.entries(BACKLOG_SPLIT_FILES)) {
    const n = lines(readFileSync(join(SRC, rel), "utf8"));
    if (max > MAX_FEATURE_FILE_LINES) bad.push(`${rel}: cap ${max} is over ${MAX_FEATURE_FILE_LINES}`);
    if (n > max) bad.push(`${rel}: ${n} lines, over its ${max} cap`);
  }
  assert.deepEqual(bad, []);
});

// ── The send sheet's split (docs/notes/send-architecture.md) ─────────────────
//
// `SendSheet.tsx` and `sendIntent.ts` are flat modules; each keeps its path as
// the facade and is cut into a folder beside it (`send/`, `sendIntent/`).
// Same two tables as the backlog's: the facades are RATCHETS (lower the number
// in the commit that moves code out); every file in the folders is LISTED once
// with its own cap, none over 500.
const SEND_FACADES = {
  "SendSheet.tsx": 70,
  "sendIntent.ts": 40,
};
const SEND_SPLIT_FILES = {
  "send/ComposeSection.tsx": 80,
  "send/FlagWhenDoneRow.tsx": 30,
  "send/LaunchRow.tsx": 60,
  "send/LeadPick.tsx": 60,
  "send/MoreRule.tsx": 110,
  "send/RetimeHint.tsx": 40,
  "send/RuleEditor.tsx": 140,
  "send/SendActions.tsx": 35,
  "send/ToSection.tsx": 205, // +the flag-when-done row (FlagWhenDoneRow) in the repo and sweep arms
  "send/WhenSection.tsx": 180,
  "send/WindowRule.tsx": 150,
  "send/sendSheetTypes.ts": 80,
  "send/sendTargets.ts": 90,
  "send/useSendSheet.ts": 350,
  "sendIntent/sendChain.ts": 175,
  "sendIntent/sendClock.ts": 150,
  "sendIntent/sendFlag.ts": 30,
  "sendIntent/sendLabels.ts": 305, // +the flag-when-done clause on the To row
  "sendIntent/sendLaunch.ts": 50,
  "sendIntent/sendLead.ts": 80,
  "sendIntent/sendRetime.ts": 170,
  "sendIntent/sendRule.ts": 115,
  "sendIntent/sendTypes.ts": 280,
};
const SEND_SPLIT_DIRS = ["send", "sendIntent"];

test("the send facades do not grow", () => {
  const over = [];
  for (const [rel, max] of Object.entries(SEND_FACADES)) {
    const n = lines(readFileSync(join(SRC, rel), "utf8"));
    if (n > max) over.push(`${rel} is ${n} lines, over its ${max} ratchet by ${n - max}`);
    else if (n < max - 50) console.log(`# ${rel} is ${n} lines — lower SEND_FACADES["${rel}"] in tools/webshape.test.mjs to lock that in`);
  }
  assert.deepEqual(over, [], `New send code belongs in send/ or sendIntent/ — docs/notes/send-architecture.md.`);
});

test("every file in send/ and sendIntent/ is listed once, under its cap", () => {
  const onDisk = SEND_SPLIT_DIRS.flatMap((d) => (existsSync(join(SRC, d))
    ? readdirSync(join(SRC, d), { recursive: true }).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => `${d}/${f.split("\\").join("/")}`)
    : [])).sort();
  const listed = Object.keys(SEND_SPLIT_FILES).sort();
  assert.deepEqual(onDisk, listed, `List each new file in SEND_SPLIT_FILES (and drop a deleted one).`);
  const bad = [];
  for (const [rel, max] of Object.entries(SEND_SPLIT_FILES)) {
    const n = lines(readFileSync(join(SRC, rel), "utf8"));
    if (max > 500) bad.push(`${rel}: cap ${max} is over 500`);
    if (n > max) bad.push(`${rel}: ${n} lines, over its ${max} cap`);
  }
  assert.deepEqual(bad, []);
});

// `TranscriptView.tsx` is the facade of the reader; its state hook and region
// components live in `transcript/` (docs/notes/transcript-architecture.md).
// `tv` prefix because basenames are unique across packages (host: `transcript.ts`).
const TV_FACADES = { "TranscriptView.tsx": 100 };
const TV_SPLIT_FILES = {
  "transcript/TvBlocks.tsx": 100,
  "transcript/TvFindBar.tsx": 60,
  "transcript/TvOutline.tsx": 40,
  "transcript/TvStrips.tsx": 100,
  "transcript/TvTail.tsx": 110,
  "transcript/TvTurn.tsx": 170,
  "transcript/tvLive.ts": 90,
  "transcript/tvParts.tsx": 85,
  "transcript/readThrough.ts": 30,
  "transcript/spentVerb.ts": 30,
  "transcript/tvRows.ts": 80,
  "transcript/tvTypes.ts": 170,
  "transcript/useTranscriptView.ts": 500,
};

test("the transcript facade does not grow", () => {
  const over = [];
  for (const [rel, max] of Object.entries(TV_FACADES)) {
    const n = lines(readFileSync(join(SRC, rel), "utf8"));
    if (n > max) over.push(`${rel} is ${n} lines, over its ${max} ratchet by ${n - max}`);
  }
  assert.deepEqual(over, [], `New reader code belongs in transcript/ — docs/notes/transcript-architecture.md.`);
});

test("every file in transcript/ is listed once, under its cap", () => {
  const onDisk = readdirSync(join(SRC, "transcript"), { recursive: true })
    .filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => `transcript/${f.split("\\").join("/")}`).sort();
  assert.deepEqual(onDisk, Object.keys(TV_SPLIT_FILES).sort(), `List each new file in TV_SPLIT_FILES.`);
  const bad = [];
  for (const [rel, max] of Object.entries(TV_SPLIT_FILES)) {
    const n = lines(readFileSync(join(SRC, rel), "utf8"));
    if (max > 500) bad.push(`${rel}: cap ${max} is over 500`);
    if (n > max) bad.push(`${rel}: ${n} lines, over its ${max} cap`);
  }
  assert.deepEqual(bad, []);
});

// ── The activity sheet's split (docs/notes/activity-architecture.md) ─────────
//
// `activityRows.ts` and `ActivitySheet.tsx` keep their paths as the facades and
// are cut into `activity/`. Same two tables as the backlog's: the facades are
// RATCHETS (lower the number in the commit that moves code out); every file in
// the folder is LISTED once with its own cap, none over 500.
const ACTIVITY_FACADES = {
  "activityRows.ts": 160,
  "ActivitySheet.tsx": 110,
};
const ACTIVITY_SPLIT_FILES = {
  "activity/ActivityBulkBar.tsx": 55,
  "activity/ActivityGroupCard.tsx": 90,
  "activity/ActivityHead.tsx": 65,
  "activity/ActivityList.tsx": 35,
  "activity/ActivityNotices.tsx": 45,
  "activity/ActivityRowCard.tsx": 330,
  "activity/activityBucket.ts": 35,
  "activity/activityBulk.ts": 125,
  "activity/activityChips.ts": 50,
  "activity/activityFilters.ts": 70,
  "activity/activityIntentRow.ts": 295,
  "activity/activityIntentWords.ts": 230,
  "activity/activityLabels.ts": 95,
  "activity/activityPieces.ts": 145,
  "activity/activityPullRow.ts": 90,
  "activity/activityQueueRow.ts": 320,
  "activity/activitySelect.ts": 150,
  "activity/activitySheetTypes.ts": 140,
  "activity/activityTriage.ts": 210,
  "activity/activityTypes.ts": 360,
  "activity/useActivityModel.ts": 135,
};
const ACTIVITY_SPLIT_DIRS = ["activity"];

test("the activity facades do not grow", () => {
  const over = [];
  for (const [rel, max] of Object.entries(ACTIVITY_FACADES)) {
    const n = lines(readFileSync(join(SRC, rel), "utf8"));
    if (n > max) over.push(`${rel} is ${n} lines, over its ${max} ratchet by ${n - max}`);
    else if (n < max - 50) console.log(`# ${rel} is ${n} lines — lower ACTIVITY_FACADES["${rel}"] in tools/webshape.test.mjs to lock that in`);
  }
  assert.deepEqual(over, [], `New activity code belongs in activity/ — docs/notes/activity-architecture.md.`);
});

test("every file in activity/ is listed once, under its cap", () => {
  const onDisk = ACTIVITY_SPLIT_DIRS.flatMap((d) => (existsSync(join(SRC, d))
    ? readdirSync(join(SRC, d), { recursive: true }).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => `${d}/${f.split("\\").join("/")}`)
    : [])).sort();
  const listed = Object.keys(ACTIVITY_SPLIT_FILES).sort();
  assert.deepEqual(onDisk, listed, `List each new file in ACTIVITY_SPLIT_FILES (and drop a deleted one).`);
  const bad = [];
  for (const [rel, max] of Object.entries(ACTIVITY_SPLIT_FILES)) {
    const n = lines(readFileSync(join(SRC, rel), "utf8"));
    if (max > 500) bad.push(`${rel}: cap ${max} is over 500`);
    if (n > max) bad.push(`${rel}: ${n} lines, over its ${max} cap`);
  }
  assert.deepEqual(bad, []);
});

// `assessRows.ts` (the assessment's pure rules) and `AssessSheet.tsx` are the
// facades of the assessment; their slices and the sheet's hook + regions live in
// `assess/` (docs/notes/assess-architecture.md). `arows`/`asx` prefixes because
// basenames are unique across packages (host and shared have `assess.ts`).
// Lower these in every commit that moves code out.
const ASSESS_FACADES = { "assessRows.ts": 110, "AssessSheet.tsx": 180 };
const ASSESS_SPLIT_FILES = {
  "assess/arowsAccept.ts": 260,
  "assess/arowsAfter.ts": 320,
  "assess/arowsApply.ts": 350,
  "assess/arowsBulk.ts": 210,
  "assess/arowsDisplay.ts": 130,
  "assess/arowsGroups.ts": 295,
  "assess/arowsRun.ts": 190,
  "assess/AsxActions.tsx": 70,
  "assess/AsxAsks.tsx": 95,
  "assess/AsxFooter.tsx": 80,
  "assess/AsxHead.tsx": 45,
  "assess/AsxMergeCard.tsx": 110,
  "assess/AsxNews.tsx": 120,
  "assess/AsxParts.tsx": 115,
  "assess/AsxRowCard.tsx": 155,
  "assess/AsxSlotCards.tsx": 135,
  "assess/AsxStrips.tsx": 110,
  "assess/AsxTail.tsx": 50,
  "assess/AsxTop.tsx": 120,
  "assess/asxConst.ts": 55,
  "assess/asxTypes.ts": 130,
  "assess/useAssessSheet.ts": 400, // + the slot check's splits (ticks, confirm) and conflict/split cards
};

test("the assessment facades do not grow", () => {
  const over = [];
  for (const [rel, max] of Object.entries(ASSESS_FACADES)) {
    const n = lines(readFileSync(join(SRC, rel), "utf8"));
    if (n > max) over.push(`${rel} is ${n} lines, over its ${max} ratchet by ${n - max}`);
  }
  assert.deepEqual(over, [], `New assessment code belongs in assess/ — docs/notes/assess-architecture.md.`);
});

test("every file in assess/ is listed once, under its cap", () => {
  const onDisk = readdirSync(join(SRC, "assess"), { recursive: true })
    .filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => `assess/${f.split("\\").join("/")}`).sort();
  assert.deepEqual(onDisk, Object.keys(ASSESS_SPLIT_FILES).sort(), `List each new file in ASSESS_SPLIT_FILES.`);
  const bad = [];
  for (const [rel, max] of Object.entries(ASSESS_SPLIT_FILES)) {
    const n = lines(readFileSync(join(SRC, rel), "utf8"));
    if (max > 500) bad.push(`${rel}: cap ${max} is over 500`);
    if (n > max) bad.push(`${rel}: ${n} lines, over its ${max} cap`);
  }
  assert.deepEqual(bad, []);
});

// ── App's split (docs/notes/app-architecture.md) ─────────────────────────────

/** Every file App's split created, with its cap — the next App is a file in
 *  this list that grew. None over 500. */
const APP_SPLIT_FILES = {
  "core/conn/useHostFrames.ts": 260,
  "core/route/overlayViews.tsx": 230,
  "core/route/useOutsideOpens.ts": 130,
  "core/session/runToolbar.ts": 120,
  "core/launcher/useLauncherView.ts": 110,
  "core/sessions/useTabStripBridge.ts": 110,
  "core/sessions/useHostState.ts": 80,
  "core/settings/useSettingsAdoption.ts": 70,
  "core/queue/useQueueSignals.ts": 70,
  "core/launcher/useRepoRefresh.ts": 60,
  "core/settings/useInstallOffer.ts": 50,
};

test("every file App's split created exists and is under its cap", () => {
  const bad = [];
  for (const [rel, max] of Object.entries(APP_SPLIT_FILES)) {
    const at = join(SRC, rel);
    if (!existsSync(at)) { bad.push(`${rel}: missing (moved back into App? drop it here and in apppins' MOVED)`); continue; }
    const n = lines(readFileSync(at, "utf8"));
    if (max > 500) bad.push(`${rel}: cap ${max} is over 500`);
    if (n > max) bad.push(`${rel}: ${n} lines, over its ${max} cap`);
  }
  assert.deepEqual(bad, []);
});

// ── pull.ts and link.ts, split (docs/notes/pulllink-architecture.md) ─────────
//
// Both keep their paths as barrels over `pull/` and `link/`. RATCHETS for the
// barrels (lower the number when code moves out); every file in the folders is
// LISTED once with its own cap, none over 500.
const PULLLINK_FACADES = {
  "pull.ts": 50,
  "link.ts": 70,
};
const PULLLINK_SPLIT_FILES = {
  "link/hostRestart.ts": 130, // "the desktop is restarting": the three edges and the strip's words
  "link/linkBus.ts": 50,
  "link/linkDoc.ts": 135,
  "link/linkLog.ts": 190,
  "link/linkMeters.ts": 175,
  "link/linkOps.ts": 85,
  "link/linkPulse.ts": 165,
  "link/linkStalls.ts": 180, // the stall record: context, fetch/XHR register, the socket sender
  "link/linkStatus.ts": 80,
  "link/linkStore.ts": 120,
  "link/linkSync.ts": 90,
  "link/linkTraffic.ts": 125,
  "link/linkTypes.ts": 200,
  "link/linkVerdict.ts": 105,
  "link/stallRecorder.ts": 150, // the stall record's pure half
  "pull/pullBgFetch.ts": 240,
  "pull/pullConsts.ts": 100,
  "pull/pullEngine.ts": 170,
  "pull/pullManager.ts": 130,
  "pull/pullNative.ts": 235,
  "pull/pullQueue.ts": 320,
  "pull/pullRange.ts": 220,
  "pull/pullSave.ts": 220,
  "pull/pullTypes.ts": 175,
};
const PULLLINK_SPLIT_DIRS = ["pull", "link"];

test("the pull and link barrels do not grow", () => {
  const over = [];
  for (const [rel, max] of Object.entries(PULLLINK_FACADES)) {
    const n = lines(readFileSync(join(SRC, rel), "utf8"));
    if (n > max) over.push(`${rel} is ${n} lines, over its ${max} ratchet by ${n - max}`);
    else if (n < max - 50) console.log(`# ${rel} is ${n} lines — lower PULLLINK_FACADES["${rel}"] in tools/webshape.test.mjs to lock that in`);
  }
  assert.deepEqual(over, [], `New code belongs in pull/ or link/ — docs/notes/pulllink-architecture.md.`);
});

test("every file in pull/ and link/ is listed once, under its cap", () => {
  const onDisk = PULLLINK_SPLIT_DIRS.flatMap((d) => (existsSync(join(SRC, d))
    ? readdirSync(join(SRC, d), { recursive: true }).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => `${d}/${f.split("\\").join("/")}`)
    : [])).sort();
  const listed = Object.keys(PULLLINK_SPLIT_FILES).sort();
  assert.deepEqual(onDisk, listed, `List each new file in PULLLINK_SPLIT_FILES (and drop a deleted one).`);
  const bad = [];
  for (const [rel, max] of Object.entries(PULLLINK_SPLIT_FILES)) {
    const n = lines(readFileSync(join(SRC, rel), "utf8"));
    if (max > 500) bad.push(`${rel}: cap ${max} is over 500`);
    if (n > max) bad.push(`${rel}: ${n} lines, over its ${max} cap`);
  }
  assert.deepEqual(bad, []);
});

// `contextPlot.ts` and `kit/chart/statsPlot.ts` are the facades of the two chart geometries; their
// slices live in `contextPlot/` and `kit/chart/stats/` (docs/notes/charts-architecture.md), the
// primitives both share in `kit/chart/chart*.ts`. Lower in every commit that moves code out.
const CHART_FACADES = { "contextPlot.ts": 62, "kit/chart/statsPlot.ts": 46 };
const CHART_SPLIT_FILES = {
  "contextPlot/cplotAgents.ts": 180,
  "contextPlot/cplotCompactSet.ts": 45,
  "contextPlot/cplotAxis.ts": 275,
  "contextPlot/cplotModels.ts": 130,
  "contextPlot/cplotPaths.ts": 195,
  "contextPlot/cplotSpark.ts": 185,
  "contextPlot/cplotSpend.ts": 295,
  "contextPlot/cplotWords.ts": 150,
  "kit/chart/chartFmt.ts": 50,
  "kit/chart/chartPath.ts": 40,
  "kit/chart/chartScale.ts": 95,
  "kit/chart/chartWords.ts": 15,
  "kit/chart/stats/splotBars.ts": 150,
  "kit/chart/stats/splotDay.ts": 180,
  "kit/chart/stats/splotMix.ts": 375,
  "kit/chart/stats/splotUsage.ts": 305,
  "kit/chart/stats/splotWeeks.ts": 215,
};

test("the chart facades do not grow", () => {
  const over = [];
  for (const [rel, max] of Object.entries(CHART_FACADES)) {
    const n = lines(readFileSync(join(SRC, rel), "utf8"));
    if (n > max) over.push(`${rel} is ${n} lines, over its ${max} ratchet by ${n - max}`);
  }
  assert.deepEqual(over, [], `New chart code belongs in contextPlot/, kit/chart/stats/ or kit/chart/ — docs/notes/charts-architecture.md.`);
});

test("every chart slice is listed once, under its cap", () => {
  const onDisk = [
    ...readdirSync(join(SRC, "contextPlot")).map((f) => `contextPlot/${f}`),
    ...readdirSync(join(SRC, "kit", "chart", "stats")).map((f) => `kit/chart/stats/${f}`),
    ...readdirSync(join(SRC, "kit", "chart")).filter((f) => /^chart.*\.ts$/.test(f)).map((f) => `kit/chart/${f}`),
  ].filter((f) => /\.(ts|tsx)$/.test(f)).sort();
  assert.deepEqual(onDisk, Object.keys(CHART_SPLIT_FILES).sort(), `List each new file in CHART_SPLIT_FILES.`);
  const bad = [];
  for (const [rel, max] of Object.entries(CHART_SPLIT_FILES)) {
    const n = lines(readFileSync(join(SRC, rel), "utf8"));
    if (max > 500) bad.push(`${rel}: cap ${max} is over 500`);
    if (n > max) bad.push(`${rel}: ${n} lines, over its ${max} cap`);
  }
  assert.deepEqual(bad, []);
});

// `ImageAnnotator.tsx` is the composer of the annotator: one state hook, four handler factories, the
// regions and the pure geometry / drawing live in `annotator/` (docs/notes/charts-architecture.md).
const ANNOTATOR_FACADES = { "ImageAnnotator.tsx": 40 };
const ANNOTATOR_SPLIT_FILES = {
  "annotator/AnnBars.tsx": 100,
  "annotator/AnnConfig.tsx": 75,
  "annotator/AnnHeadKeys.tsx": 45,
  "annotator/AnnPrompt.tsx": 40,
  "annotator/AnnSendBar.tsx": 55,
  "annotator/AnnStage.tsx": 48,
  "annotator/AnnTextOnly.tsx": 45,
  "annotator/AnnToolbar.tsx": 105,
  "annotator/annDraw.ts": 270,
  "annotator/annEdit.ts": 150,
  "annotator/annGeom.ts": 95,
  "annotator/annOcr.ts": 70,
  "annotator/annPointer.ts": 280,
  "annotator/annRead.ts": 115,
  "annotator/annSend.ts": 155,
  "annotator/annTypes.ts": 170,
  "annotator/useAnnotator.ts": 290, // +"text only" (annOcr.ts) state
};

test("the annotator facade does not grow", () => {
  const over = [];
  for (const [rel, max] of Object.entries(ANNOTATOR_FACADES)) {
    const n = lines(readFileSync(join(SRC, rel), "utf8"));
    if (n > max) over.push(`${rel} is ${n} lines, over its ${max} ratchet by ${n - max}`);
  }
  assert.deepEqual(over, [], `New annotator code belongs in annotator/ — docs/notes/charts-architecture.md.`);
});

test("every file in annotator/ is listed once, under its cap", () => {
  const onDisk = readdirSync(join(SRC, "annotator"), { recursive: true })
    .filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => `annotator/${f.split("\\").join("/")}`).sort();
  assert.deepEqual(onDisk, Object.keys(ANNOTATOR_SPLIT_FILES).sort(), `List each new file in ANNOTATOR_SPLIT_FILES.`);
  const bad = [];
  for (const [rel, max] of Object.entries(ANNOTATOR_SPLIT_FILES)) {
    const n = lines(readFileSync(join(SRC, rel), "utf8"));
    if (max > 500) bad.push(`${rel}: cap ${max} is over 500`);
    if (n > max) bad.push(`${rel}: ${n} lines, over its ${max} cap`);
  }
  assert.deepEqual(bad, []);
});

// ── The HTTP client, the gallery and the repo-health words (docs/notes/webclient-architecture.md) ──
//
// `api.ts`, `Gallery.tsx` and `repoHealthWords.ts` stay at their paths as
// facades over `webapi/`, `gallery/` and `repoHealthWords/`. Facades are
// RATCHETS; every file in the three folders is LISTED once with its own cap.

/** The most lines each facade may have. Lower it when you move code out. */
const WEBCLIENT_FACADES = {
  "api.ts": 35,
  "Gallery.tsx": 20,
  "repoHealthWords.ts": 60,
};

/** Every file in the split folders, by path under `packages/web/src`, and its cap. */
const WEBCLIENT_SPLIT_FILES = {
  "webapi/webapiAskRules.ts": 30,
  "webapi/webapiBg.ts": 30,
  "webapi/webapiBody.ts": 50, // a body read with a stall fuse + progress, and JSON under it
  "webapi/webapiClipboard.ts": 25,
  "webapi/webapiFetch.ts": 105,
  "webapi/webapiFiles.ts": 153, // +fileBlob, the gallery combine's bytes; +abortXhr, the stall record
  "webapi/webapiGit.ts": 75, // +pull, +log/show/fetch, +blob progress
  "webapi/webapiHost.ts": 150, // +on-device whole-picture OCR
  "webapi/webapiNet.ts": 155,
  "webapi/webapiRepoOps.ts": 103, // +opt-ins (read, choice, and the row cleaner)
  "webapi/webapiRepos.ts": 50,
  "webapi/webapiRoot.ts": 20,
  "webapi/webapiSessions.ts": 105,
  "webapi/webapiStats.ts": 85,
  "webapi/webapiTree.ts": 55,
  "webapi/webapiTypes.ts": 145,
  "gallery/DocIcon.tsx": 30,
  "gallery/GalleryBar.tsx": 105, // where/what moved to GalleryFilters
  "gallery/GalleryFilters.tsx": 65,
  "gallery/GalleryPickBar.tsx": 30,
  "gallery/GalleryGrid.tsx": 104, // +the empty grid under a time cut, with its way out; +the combine pick on a tile
  "gallery/GallerySessionPick.tsx": 65,
  "gallery/GalleryTiles.tsx": 60,
  "gallery/GalleryViewer.tsx": 150,
  "gallery/galleryCuts.ts": 20,
  "gallery/galleryPick.ts": 20,
  "gallery/galleryTypes.ts": 140,
  "gallery/galleryUrls.ts": 25,
  "gallery/useGallery.tsx": 205,
  "gallery/useGalleryListing.ts": 190,
  "gallery/useGalleryOpen.ts": 50,
  "gallery/useGalleryPick.ts": 35,
  "gallery/useGalleryViewer.ts": 110,
  "repoHealthWords/repoHealthWordsCentral.ts": 70, // a repo's disable/override of a central reading, on its tile
  "repoHealthWords/repoHealthWordsEngine.ts": 115,
  "repoHealthWords/repoHealthWordsFmt.ts": 85, // +middleEllipsis, the longest card's path
  "repoHealthWords/repoHealthWordsOwn.ts": 90,
  "repoHealthWords/repoHealthWordsPlot.ts": 155,
  "repoHealthWords/repoHealthWordsRank.ts": 125,
  "repoHealthWords/repoHealthWordsRegion.ts": 195, // +notesSummaryWords, plotAxisModeWords (weeks | commits)
  "repoHealthWords/repoHealthWordsRun.ts": 115, // +outcomeRepeatsReadError, a failed read said once
  "repoHealthWords/repoHealthWordsScope.ts": 60,
  "repoHealthWords/repoHealthWordsStale.ts": 130, // +seriesStatusWords, the one line over the series charts
};
const WEBCLIENT_SPLIT_DIRS = ["webapi", "gallery", "repoHealthWords"];

test("the web-client facades do not grow", () => {
  const over = [];
  for (const [rel, max] of Object.entries(WEBCLIENT_FACADES)) {
    const n = lines(readFileSync(join(SRC, rel), "utf8"));
    if (n > max) over.push(`${rel} is ${n} lines, over its ${max} ratchet by ${n - max}`);
  }
  assert.deepEqual(over, [], `New code belongs in the slice folders — docs/notes/webclient-architecture.md.`);
});

test("every file in webapi/, gallery/ and repoHealthWords/ is listed once, under its cap", () => {
  const onDisk = WEBCLIENT_SPLIT_DIRS.flatMap((d) => (existsSync(join(SRC, d))
    ? readdirSync(join(SRC, d), { recursive: true }).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => `${d}/${f.split("\\").join("/")}`)
    : [])).sort();
  assert.deepEqual(onDisk, Object.keys(WEBCLIENT_SPLIT_FILES).sort(), `List each new file in WEBCLIENT_SPLIT_FILES.`);
  const bad = [];
  for (const [rel, max] of Object.entries(WEBCLIENT_SPLIT_FILES)) {
    const n = lines(readFileSync(join(SRC, rel), "utf8"));
    if (max > 500) bad.push(`${rel}: cap ${max} is over 500`);
    if (n > max) bad.push(`${rel}: ${n} lines, over its ${max} cap`);
  }
  assert.deepEqual(bad, []);
});
