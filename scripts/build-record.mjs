#!/usr/bin/env node
// Append one build record to <repo>/.waterplane/versions.jsonl — the line the phone's build list
// reads to say which build each entry last produced (`@waterplane/shared` buildstamp.ts).
//
//   node scripts/build-record.mjs --name vscode-extension [--stamp dist/buildstamp.json]
//        [--stamp-json '{"version":…}'] [--version 0.7.0] [--channel "installed in VS Code"]
//        [--file packages/vscode/x.vsix]
//
// --stamp reads the identity the build baked into the artifact, so the record and the artifact
// say the same thing (--stamp-json: the same, already read — a release reads it out of the APK); without it the version is --version and the commit and time are taken now.
// Dependency-free on purpose: another repo can copy it as it is. A record that cannot be written
// is a warning, never a failed build.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const git = (...a) => { try { return execFileSync("git", a, { encoding: "utf8" }).trim(); } catch { return ""; } };

const name = opt("name");
if (!name) { console.error("build-record: --name is required"); process.exit(2); }
let stamp = {};
if (opt("stamp-json")) {
  try { stamp = JSON.parse(opt("stamp-json")); }
  catch (e) { console.warn(`build-record: --stamp-json unreadable (${e.message}); taking commit and time now`); }
} else if (opt("stamp")) {
  try { stamp = JSON.parse(readFileSync(opt("stamp"), "utf8")); }
  catch (e) { console.warn(`build-record: ${opt("stamp")} unreadable (${e.message}); taking commit and time now`); }
}
const sha = git("rev-parse", "--short", "HEAD");
const record = {
  name,
  version: opt("version") ?? stamp.version,
  sha: stamp.sha ?? (sha || undefined),
  // A stamp is the build's own word on its tree, clean included; only without one is the tree asked now.
  dirty: stamp.at ? stamp.dirty || undefined : git("status", "--porcelain") !== "" || undefined,
  at: stamp.at ?? Date.now(),
  channel: opt("channel"),
  file: opt("file"),
};
const root = git("rev-parse", "--show-toplevel") || process.cwd();
try {
  mkdirSync(path.join(root, ".waterplane"), { recursive: true });
  appendFileSync(path.join(root, ".waterplane", "versions.jsonl"), JSON.stringify(record) + "\n");
  console.log(`build-record: ${name} ${[record.version, record.sha && `${record.sha}${record.dirty ? " + edits" : ""}`].filter(Boolean).join(" · ")}${record.channel ? ` → ${record.channel}` : ""}`);
} catch (e) {
  console.warn(`build-record: not recorded (${e.message})`);
}
