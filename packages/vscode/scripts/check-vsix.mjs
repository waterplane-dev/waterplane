// Asserts a packaged .vsix holds what it should and nothing else. Usage: node check-vsix.mjs x.vsix
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { gitOnlyProblems } from "./gitonly.mjs";

const file = process.argv[2];
if (!file) { console.error("usage: check-vsix.mjs <file.vsix>"); process.exit(2); }

const names = execFileSync("unzip", ["-Z1", file], { encoding: "utf8" })
  .split("\n").filter(Boolean).map((n) => n.replace(/^extension\//, ""));
const bad = [];
for (const need of ["dist/extension.js", "dist/scanworker.js", "dist/healthworker.mjs", "media/activity.svg", "dist/webview.js", "dist/webview.css", "README.md", "LICENSE", "icon.png", "package.json"]) {
  // vsce lower-cases readme/changelog and adds .txt to LICENSE.
  const want = need.toLowerCase();
  if (!names.some((n) => n.toLowerCase() === want || n.toLowerCase() === `${want}.txt`)) bad.push(`missing ${need}`);
}
for (const n of names) {
  if (/\.map$/.test(n)) bad.push(`source map shipped: ${n}`);
  if (/^(src|test|webview|scripts)\//.test(n)) bad.push(`source shipped: ${n}`);
  if (/(^|\/)node_modules\//.test(n)) bad.push(`node_modules shipped: ${n}`);
}
// Only the repo-health worker may start a process, and only git (README "Privacy" says so).
for (const n of names.filter((x) => /^dist\/.*\.(m?js)$/.test(x))) {
  const text = execFileSync("unzip", ["-p", file, `extension/${n}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (n !== "dist/healthworker.mjs" && text.includes("child_process")) bad.push(`child_process in ${n}`);
  // …and in the one that may, every call site of a child_process function starts "git" — read
  // off the minified text that ships, whatever names the bundler gave the bindings.
  if (n === "dist/healthworker.mjs") {
    if (!text.includes("child_process")) bad.push(`${n} imports no child_process: the check below would pass vacuously`);
    for (const p of gitOnlyProblems(text)) bad.push(`${n}: ${p}`);
  }
}
const size = statSync(file).size;
if (size >= 3 * 1024 * 1024) bad.push(`size ${(size / 1048576).toFixed(2)} MB >= 3 MB`);
if (bad.length) { console.error(`${file}:\n  ${bad.join("\n  ")}`); process.exit(1); }
console.log(`${file}: ok (${names.length} files, ${(size / 1024).toFixed(0)} KB)`);
