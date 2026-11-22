// Five bundles: the extension, the scan worker, the webview, the data layer for the tests, and the
// repo-health worker (the bundled engine, the one file that may start a process — only `git`). `node esbuild.mjs [--watch] [--release]`.
import { build, context } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const at = (...p) => path.join(here, ...p);
const watch = process.argv.includes("--watch");
const release = process.argv.includes("--release");

const hostSrc = path.resolve(here, "../host/src") + path.sep;
const hostEnv = path.resolve(here, "../host/src/env.ts");

// Host modules read config through their own `./env.js` (or `../env.js` from a subdir). A plain
// alias does not match relative specifiers, so redirect by (specifier, importer) to the shim.
const envShim = {
  name: "host-env-shim",
  setup(b) {
    b.onResolve({ filter: /(^|\/)env\.js$/ }, (args) => {
      if (!args.importer.startsWith(hostSrc)) return null;
      if (path.resolve(args.resolveDir, args.path.replace(/\.js$/, ".ts")) !== hostEnv) return null;
      return { path: at("src/shims/hostenv.ts") };
    });
  },
};

// `ctxagents.ts` is bundled for real (subagent lanes); its one impure import is `readMeta` from
// `../agents.js`, which drags agents.ts → proc.ts → node:child_process. Redirect only that import.
const hostAgents = path.resolve(here, "../host/src/agents.ts");
const agentsShim = {
  name: "agents-meta-shim",
  setup(b) {
    b.onResolve({ filter: /(^|\/)agents\.js$/ }, (args) => {
      if (!args.importer.startsWith(hostSrc)) return null;
      if (path.resolve(args.resolveDir, args.path.replace(/\.js$/, ".ts")) !== hostAgents) return null;
      return { path: at("src/shims/agentmeta.ts") };
    });
  },
};

// The permissions extension is private (not in the public tree): the Findings view bundles its engine
// when the tree holds it, and a stand-in that answers nothing when it does not.
const real = path.resolve(here, "../extensions/permissions/host/vscodebridge.mts");
const permissionsOptional = {
  name: "permissions-optional",
  setup(b) {
    b.onResolve({ filter: /^permissions-engine$/ }, () => ({
      path: existsSync(real) ? real : at("src/shims/permissionsabsent.ts"),
    }));
  },
};

// The web HintChip drags hints.ts → storage.ts and usage.ts; the webview gets its own.
const webSrc = path.resolve(here, "../web/src") + path.sep;
const hintChip = {
  name: "hintchip-shim",
  setup(b) {
    b.onResolve({ filter: /(^|\/)HintChip(\.js|\.tsx)?$/ }, (a) =>
      a.importer.startsWith(webSrc) ? { path: at("webview/shims/HintChip.tsx") } : null);
  },
};

// The phone's read hook and its stats API run in the webview as they are; only their socket-facing
// imports are swapped: `useRemoteResource.ts`'s `./api` and `./link`, `webapiStats.ts`'s
// `./webapiFetch` (its `jget` goes through the extension host to the desktop on loopback).
// `kit/offlineGate.tsx`'s `../link` is swapped the same way (the webview has no socket to lose, so the
// gate is always open) and `useRemoteResource.ts`'s `./offlineCache` for a store that keeps nothing:
// the real one reaches the phone's whole api layer, hosts and an IndexedDB the webview has no use for.
const phoneSwapList = [
  [path.join(webSrc, "useRemoteResource.ts"), /^\.\/api(\.ts)?$/, "webview/shims/api.ts"],
  [path.join(webSrc, "useRemoteResource.ts"), /^\.\/link(\.ts)?$/, "webview/shims/link.ts"],
  [path.join(webSrc, "useRemoteResource.ts"), /^\.\/offlineCache(\.ts)?$/, "webview/shims/rescache.ts"],
  [path.join(webSrc, "kit", "offlineGate.tsx"), /^\.\.\/link(\.ts)?$/, "webview/shims/link.ts"],
  [path.join(webSrc, "webapi", "webapiStats.ts"), /^\.\/webapiFetch(\.ts)?$/, "webview/shims/jget.ts"],
];
const phoneReads = {
  name: "phone-reads",
  setup(b) {
    b.onResolve({ filter: /^\.\.?\/(api|link|webapiFetch|offlineCache)(\.ts)?$/ }, (a) => {
      const hit = phoneSwapList.find(([importer, re]) => a.importer === importer && re.test(a.path));
      return hit ? { path: at(hit[2]) } : null;
    });
  },
};

// The repo-health engine (tools/repohealth.mjs) is bundled as it is. Two of its modules are
// swapped: statefile.mjs (the series goes to VS Code's global storage, never into the folder),
// judge.mjs (the one module that spends tokens — nothing here does), narrate.mjs + html.mjs
// (the two that write into the folder — nothing here does), and own.mjs's and metrics/native.mjs's child_process (below). Its two imports of
// packages/shared/dist resolve to shared's source like everything else here.
const tools = path.resolve(here, "../../tools") + path.sep;
const redirect = (name, filter, to) => ({
  name,
  setup(b) {
    b.onResolve({ filter }, (a) => (a.importer.startsWith(tools) ? { path: at(to) } : null));
  },
});
const healthState = redirect("health-statefile", /(^|\/)statefile\.mjs$/, "src/shims/healthstate.ts");
const healthJudge = redirect("health-judge", /(^|\/)judge\.mjs$/, "src/shims/healthjudge.ts");
// narrate.mjs and html.mjs write into the folder's `.claude/outbox/`; the extension never runs them.
const healthUnused = redirect("health-unused", /(^|\/)(narrate|html)\.mjs$/, "src/shims/healthunused.ts");
// own.mjs spawns the commands a repo declares (its own readings, an override of a central one).
// The extension runs only git: own.mjs's child_process is a spawnSync that throws, so each such
// reading lands ABSENT with that reason (src/shims/healthnorun.ts) — git.mjs keeps the real one.
// metrics/native.mjs (a repo's analyzers, scanner, type checker) gets the same promise through
// src/shims/healthnotool.ts, whose spawnSync returns an error result instead of throwing.
const noRunShims = new Map([
  [path.join(tools, "repohealth", "own.mjs"), "src/shims/healthnorun.ts"],
  [path.join(tools, "repohealth", "metrics", "native.mjs"), "src/shims/healthnotool.ts"],
]);
const healthNoRun = {
  name: "health-norun",
  setup(b) {
    b.onResolve({ filter: /^(node:)?child_process$/ }, (a) => (noRunShims.has(a.importer) ? { path: at(noRunShims.get(a.importer)) } : null));
  },
};

// React must be ONE copy in the webview. `nodePaths` below only applies when normal resolution
// fails, and the repo root's node_modules also holds react: modules under ../web/src found that
// copy, and the panel (the one that draws those charts) threw "reading 'useState'" at mount and
// stayed blank. Resolve react and react-dom from this package, whoever imports them.
const ownRequire = createRequire(at("package.json"));
const oneReact = {
  name: "one-react",
  setup(b) {
    b.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (a) => ({ path: ownRequire.resolve(a.path) }));
  },
};

const shared = path.resolve(here, "../shared/src/index.ts");
const alias = { "@waterplane/shared": shared };
const sharedDist = {
  name: "shared-dist",
  setup(b) {
    b.onResolve({ filter: /packages\/shared\/dist\/index\.js$/ }, () => ({ path: shared }));
  },
};
// Which build is this (`@waterplane/shared` buildstamp.ts): version + commit + time, baked into the
// extension and the webview as `__WP_BUILD__` and written to dist/buildstamp.json so the package
// script records the SAME identity in the repo's versions.jsonl. `dirty` covers every tree this
// bundles from, because a build of uncommitted edits is not the commit its sha names.
const git = (...a) => { try { return execFileSync("git", a, { cwd: here, encoding: "utf8" }).trim(); } catch { return ""; } };
const buildStamp = {
  version: JSON.parse(readFileSync(at("package.json"), "utf8")).version,
  sha: git("rev-parse", "--short", "HEAD") || undefined,
  dirty: git("status", "--porcelain", "--", ".", "../shared/src", "../host/src", "../web/src", "../extensions", "../../tools") !== "" || undefined,
  at: Date.now(),
};
mkdirSync(at("dist"), { recursive: true });
const common = {
  bundle: true,
  logLevel: "info",
  legalComments: "none",
  sourcemap: release ? false : "linked",
  minify: release,
  // react / lucide imported from ../web/src and ../extensions must find THIS package's copy.
  nodePaths: [at("node_modules")],
  // shared's internal `./x.js` specifiers are really `.ts` (esbuild retries .js -> .ts itself).
  resolveExtensions: [".ts", ".tsx", ".js", ".mjs", ".json"],
  define: { __WP_BUILD__: JSON.stringify(buildStamp) },
};

const configs = [
  {
    ...common,
    entryPoints: [at("src/extension.ts")],
    outfile: at("dist/extension.js"),
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
    alias,
    plugins: [envShim, agentsShim, permissionsOptional],
  },
  {
    // The all-sessions scan runs in a worker_threads Worker off the extension host's thread.
    ...common,
    entryPoints: [at("src/scanworker.ts")],
    outfile: at("dist/scanworker.js"),
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
    alias,
    plugins: [envShim, agentsShim, permissionsOptional],
  },
  {
    ...common,
    entryPoints: [at("webview/main.tsx")],
    outfile: at("dist/webview.js"), // main.tsx's CSS import lands next to it as dist/webview.css
    platform: "browser",
    format: "iife",
    target: "es2022",
    jsx: "automatic",
    // The webview's own kit barrel (chart pieces + `until` + `Explain`), never the full kit.
    alias: { ...alias, "@waterplane/kit": at("webview/shims/kit.ts"), "@waterplane/sdk": at("webview/shims/sdk.ts") },
    define: { ...common.define, "process.env.NODE_ENV": JSON.stringify(release ? "production" : "development") },
    loader: { ".css": "css" },
    plugins: [hintChip, oneReact, phoneReads],
  },
  {
    ...common,
    entryPoints: [at("src/data/index.ts")],
    outfile: at("dist/data.mjs"),
    platform: "node",
    format: "esm",
    target: "node20",
    external: ["vscode"],
    alias,
    plugins: [envShim, agentsShim, permissionsOptional],
  },
  {
    // The repo-health engine in a worker_threads Worker. ESM: the engine uses top-level await,
    // import.meta.url and createRequire. `typescript` stays external (loaded lazily; absent in
    // the VSIX, which the engine reports as "typescript not installed").
    ...common,
    entryPoints: [at("src/healthworker.ts")],
    outfile: at("dist/healthworker.mjs"),
    platform: "node",
    format: "esm",
    target: "node20",
    external: ["vscode", "typescript"],
    // check-vsix reads "only git" off this file's shipped text. Minified, `spawnSync` became `ci`
    // and every "local-ci"/"npm ci" in the bundled preset prose counted as a call (0.8.0 release).
    minify: false, minifyWhitespace: release, minifySyntax: release,
    alias,
    plugins: [healthState, healthJudge, healthUnused, healthNoRun, sharedDist],
  },
];

// A release build writes no source maps; drop a dev build's, so dist/ holds only what ships.
if (release && existsSync(at("dist"))) {
  for (const f of readdirSync(at("dist"), { withFileTypes: true })) {
    if (f.isFile() && f.name.endsWith(".map")) rmSync(at("dist", f.name));
  }
}
writeFileSync(at("dist/buildstamp.json"), JSON.stringify(buildStamp) + "\n");

// bundled-sources.json: which host, web and extension modules these bundles carry, and which of their
// imports the plugins above swap. Those modules live in packages that build fine on their own, so a
// new import there (a host module that spawns, a node: builtin in the webview, a package this one
// does not install) broke only `npm run test:vscode`. tools/vscodebundle.test.mjs reads this list
// at edit time and fails as soon as a listed module imports something outside it. The build fails
// on a module the list does not hold yet; `--sources` rewrites the list after you checked it.
const repo = path.join(here, "..", "..");
const rel = (abs) => path.relative(repo, abs).split(path.sep).join("/");
const SOURCES = at("bundled-sources.json");
const inScope = (f) => /^packages\/(host\/src|web\/src|extensions\/[^/]+\/(host|web|shared))\//.test(f)
  && !f.startsWith("packages/extensions/permissions/"); // private, resolved by alias, absent in the public tree
const shimTable = {
  shimmed: [hostEnv, hostAgents, path.join(webSrc, "HintChip.tsx")].map(rel),
  swaps: phoneSwapList.map(([importer, re]) => ({ importer: rel(importer), spec: re.source })),
};

if (watch) {
  for (const c of configs) await (await context(c)).watch();
  console.log("watching…");
} else {
  // WP_VSCODE_INPUTS=<file>: also write every source file the bundles read, one repo-relative path
  // per line (node_modules left out). The release train reads it to tell whether the extension
  // changed since the last release, since it bundles host/web/shared modules from source.
  const inputs = process.env.WP_VSCODE_INPUTS;
  const results = await Promise.allSettled(configs.map((c) => build({ ...c, metafile: true })));
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length) process.exit(1);
  const files = new Set();
  for (const r of results) for (const f of Object.keys(r.value.metafile.inputs)) {
    if (f.includes("node_modules") || f.includes(":")) continue;
    files.add(rel(path.join(process.cwd(), f)));
  }
  if (inputs) writeFileSync(inputs, [...files].sort().join("\n") + "\n");
  const now = { ...shimTable, files: [...files].filter(inScope).sort() };
  const was = existsSync(SOURCES) ? JSON.parse(readFileSync(SOURCES, "utf8")) : { files: [] };
  const added = now.files.filter((f) => !was.files.includes(f));
  const dropped = was.files.filter((f) => !now.files.includes(f));
  const shimsMoved = JSON.stringify([was.shimmed, was.swaps]) !== JSON.stringify([now.shimmed, now.swaps]);
  if (process.argv.includes("--sources")) {
    writeFileSync(SOURCES, JSON.stringify(now, null, 2) + "\n");
    console.log(`bundled-sources.json: ${now.files.length} modules (+${added.length} −${dropped.length})`);
  } else if (added.length || shimsMoved) {
    console.error(`bundled-sources.json is behind the bundles:\n${added.map((f) => `  + ${f}\n`).join("")}${shimsMoved ? "  (the shim table changed)\n" : ""}`
      + "Each new module above now ships in the VS Code extension. Check it imports nothing the extension cannot carry\n"
      + "(child_process, a host module that spawns or reads env.ts, a node: builtin in the webview), then run\n"
      + "`node packages/vscode/esbuild.mjs --sources` and commit the list.");
    process.exit(1);
  } else if (dropped.length) {
    console.log(`bundled-sources.json lists ${dropped.length} module(s) no longer bundled; \`node esbuild.mjs --sources\` drops them.`);
  }
}
