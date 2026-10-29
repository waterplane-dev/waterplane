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
const phoneReads = {
  name: "phone-reads",
  setup(b) {
    const swaps = [
      [path.join(webSrc, "useRemoteResource.ts"), /^\.\/api(\.ts)?$/, "webview/shims/api.ts"],
      [path.join(webSrc, "useRemoteResource.ts"), /^\.\/link(\.ts)?$/, "webview/shims/link.ts"],
      [path.join(webSrc, "webapi", "webapiStats.ts"), /^\.\/webapiFetch(\.ts)?$/, "webview/shims/jget.ts"],
    ];
    b.onResolve({ filter: /^\.\/(api|link|webapiFetch)(\.ts)?$/ }, (a) => {
      const hit = swaps.find(([importer, re]) => a.importer === importer && re.test(a.path));
      return hit ? { path: at(hit[2]) } : null;
    });
  },
};

// The repo-health engine (tools/repohealth.mjs) is bundled as it is. Two of its modules are
// swapped: statefile.mjs (the series goes to VS Code's global storage, never into the folder),
// judge.mjs (the one module that spends tokens — nothing here does), narrate.mjs + html.mjs
// (the two that write into the folder — nothing here does), and own.mjs's child_process (below). Its two imports of
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
const ownMjs = path.join(tools, "repohealth", "own.mjs");
const healthNoRun = {
  name: "health-norun",
  setup(b) {
    b.onResolve({ filter: /^(node:)?child_process$/ }, (a) => (a.importer === ownMjs ? { path: at("src/shims/healthnorun.ts") } : null));
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
    plugins: [envShim, agentsShim],
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
    plugins: [envShim, agentsShim],
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
    plugins: [envShim, agentsShim],
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

if (watch) {
  for (const c of configs) await (await context(c)).watch();
  console.log("watching…");
} else {
  const results = await Promise.allSettled(configs.map((c) => build(c)));
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length) process.exit(1);
}
