#!/usr/bin/env node
// `npm run build:demo-web` — the static web demo: the ordinary web bundle in `dist-demo/` (gitignored;
// never packages/web/dist, which ships to the phone over the air), with one inline line in index.html
// so that opening it on ANY static origin lands in the demo instead of the "no repos" screen:
//
//   if the URL names no scenario, `?demo=first-look` is added with history.replaceState (no reload,
//   nothing stored — `?demo=` writes nothing, see demo/mode.ts). An explicit `?demo=<other>` is kept.
//
// Sub-path hosting (https://user.github.io/waterplane/): WATERPLANE_DEMO_BASE=/waterplane/ npm run build:demo-web
// Hosting notes: docs/play-review.md "Static web demo".
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(ROOT, "dist-demo");
const dist = path.join(ROOT, "packages/web/dist");
if (path.resolve(out).startsWith(dist)) throw new Error("refusing to build into packages/web/dist");
// The brand (env spelling) is read off packages/shared/dist, which a fresh `npm ci` does not have:
// build shared BEFORE importing it, or a clean clone dies with ERR_MODULE_NOT_FOUND.
const shared = spawnSync("npm", ["run", "build:shared"], { cwd: ROOT, stdio: "inherit" });
if (shared.status !== 0) process.exit(shared.status ?? 1);
const { E } = await import("./lib-brand.mjs");
const base = process.env[E.DEMO_BASE] || "/";
const r = spawnSync("npx", ["vite", "build", "--outDir", out, "--emptyOutDir", "--base", base], { cwd: path.join(ROOT, "packages/web"), stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);

const LINE = `<script>/* static demo build: land in the demo */try{var u=new URL(location.href);if(!u.searchParams.has("demo")){u.searchParams.set("demo","first-look");history.replaceState(null,"",u.toString())}}catch(e){}</script>`;
const file = path.join(out, "index.html");
const html = fs.readFileSync(file, "utf8");
if (!html.includes("<head>")) throw new Error("index.html has no <head> to put the demo line in");
fs.writeFileSync(file, html.replace("<head>", "<head>" + LINE));
console.log(`static web demo: ${path.relative(ROOT, out)}/ (base ${base}) — serve it from any static host; opens in ?demo=first-look`);
