#!/usr/bin/env node
// Writes the Android shell's identity from BRAND (packages/shared/src/brand.ts), so a fork
// renames in one place:   npm run brand:android             rewrite in place
//                         npm run brand:android -- --check  exit 1 if anything would change
// Reads the BUILT table (`npm run build:shared` first, like every test). Idempotent: each rule
// matches the structure around a value, not the old value, so it works from any identity.
//
// Writes: capacitor.config.ts (appId, appName) · android/app/build.gradle (namespace,
// applicationId; the `.dev` flavor suffix is not brand-bearing and stays) · res/values/strings.xml
// and src/dev/res/values/strings.xml (labels, package_name, custom_url_scheme) ·
// AndroidManifest.xml (pairing scheme) · the Java package dir (`package`/`import` lines, the
// `<appId>.…` intent actions, the scheme and name literals), MOVED when appId changes.
// Not touched: keystores, signing, and prose in comments beyond the structural ones named above.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "packages/app");
const ANDROID = path.join(APP, "android/app");
const JAVA = path.join(ANDROID, "src/main/java");
const check = process.argv.includes("--check");

const distBrand = path.join(ROOT, "packages/shared/dist/brand.js");
if (!fs.existsSync(distBrand)) {
  console.error("brand-android: packages/shared/dist/brand.js is missing — run `npm run build:shared` first");
  process.exit(2);
}
const { BRAND } = await import(pathToFileURL(distBrand).href);
const { appId, name, displayName, pairScheme } = BRAND;
if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(appId)) {
  console.error(`brand-android: BRAND.appId "${appId}" is not a valid Android package name`);
  process.exit(2);
}

const changes = [];
const rel = (p) => path.relative(ROOT, p);
function write(p, text, before) {
  if (text === before) return;
  changes.push(rel(p));
  if (!check) fs.writeFileSync(p, text);
}
/** Replace `re`'s match with `to`; a rule that matches nothing is a broken rule, not a no-op. */
function sub(text, re, to, what) {
  if (!re.test(text)) throw new Error(`brand-android: rule "${what}" matched nothing — the file's shape changed`);
  return text.replace(re, to);
}
function edit(p, rules) {
  const before = fs.readFileSync(p, "utf8");
  let t = before;
  for (const [re, to, what] of rules) t = sub(t, re, to, what);
  write(p, t, before);
}

edit(path.join(APP, "capacitor.config.ts"), [
  [/(appId: )"[^"]*"/, `$1"${appId}"`, "appId"],
  [/(appName: )"[^"]*"/, `$1"${displayName}"`, "appName"],
]);

edit(path.join(ANDROID, "build.gradle"), [
  [/(namespace = )"[^"]*"/, `$1"${appId}"`, "namespace"],
  [/(applicationId )"[^"]*"/, `$1"${appId}"`, "applicationId"],
  [/\(`[\w.]+\.dev`\)/, `(\`${appId}.dev\`)`, "dev comment id"],
  [/\(`[\w.]+`, permanent/, `(\`${appId}\`, permanent`, "play comment id"],
]);

edit(path.join(ANDROID, "src/main/res/values/strings.xml"), [
  [/(<string name="app_name">)[^<]*/, `$1${displayName}`, "app_name"],
  [/(<string name="title_activity_main">)[^<]*/, `$1${displayName}`, "title_activity_main"],
  [/(<string name="package_name">)[^<]*/, `$1${appId}`, "package_name"],
  [/(<string name="custom_url_scheme">)[^<]*/, `$1${appId}`, "custom_url_scheme"],
]);
edit(path.join(ANDROID, "src/dev/res/values/strings.xml"), [
  [/(<string name="app_name">)[^<]*/, `$1${displayName} dev`, "dev app_name"],
  [/(<string name="title_activity_main">)[^<]*/, `$1${displayName} dev`, "dev title_activity_main"],
]);

edit(path.join(ANDROID, "src/main/AndroidManifest.xml"), [
  [/(android:scheme=)"[^"]*"( android:host="pair")/, `$1"${pairScheme}"$2`, "pair scheme"],
  [/`[\w-]+(:\/\/pair\?u=)/, `\`${pairScheme}$1`, "pair link comment"],
]);

// Java: the package is the directory holding the sources; find it, move it if it changed.
function javaDirs(dir) {
  const out = [];
  const walk = (d) => {
    const es = fs.readdirSync(d, { withFileTypes: true });
    if (es.some((e) => e.isFile() && e.name.endsWith(".java"))) out.push(d);
    for (const e of es) if (e.isDirectory()) walk(path.join(d, e.name));
  };
  walk(dir);
  return out;
}
const dirs = javaDirs(JAVA);
if (dirs.length !== 1) throw new Error(`brand-android: expected one Java package dir under ${rel(JAVA)}, found ${dirs.length}`);
const oldDir = dirs[0];
const oldPkg = path.relative(JAVA, oldDir).split(path.sep).join(".");
const newDir = path.join(JAVA, ...appId.split("."));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

for (const f of fs.readdirSync(oldDir).filter((n) => n.endsWith(".java"))) {
  const src = path.join(oldDir, f);
  const before = fs.readFileSync(src, "utf8");
  let t = before;
  t = t.replace(new RegExp(`^(package |import (?:static )?)${esc(oldPkg)}(?=[.;])`, "gm"), `$1${appId}`);
  t = t.replace(new RegExp(`"${esc(oldPkg)}\\.`, "g"), `"${appId}.`); // intent actions
  t = t.replace(/(\.setContentTitle\()"[^"]*"/g, `$1"${displayName}"`);
  t = t.replace(/(optString\("title", )"[^"]*"/g, `$1"${displayName}"`);
  t = t.replace(/(\.openWrite\()"[^"]*"/g, `$1"${name}"`);
  t = t.replace(/"[^"]*"(\.equalsIgnoreCase\(data\.getScheme\(\)\))/g, `"${pairScheme}"$1`);
  const dest = path.join(newDir, f);
  if (src !== dest) {
    changes.push(`${rel(src)} -> ${rel(dest)}`);
    if (!check) {
      fs.mkdirSync(newDir, { recursive: true });
      fs.writeFileSync(dest, t);
      fs.rmSync(src);
    }
  } else write(src, t, before);
}
if (!check && oldDir !== newDir) {
  // Prune the emptied package dirs, stopping at java/.
  for (let d = oldDir; d !== JAVA && fs.readdirSync(d).length === 0; d = path.dirname(d)) fs.rmdirSync(d);
}

if (check) {
  if (changes.length) {
    console.error(`brand-android: the Android shell has drifted from BRAND (${changes.length}):\n  ${changes.join("\n  ")}\nrun \`npm run brand:android\``);
    process.exit(1);
  }
  console.log("brand-android: Android shell matches BRAND");
} else {
  console.log(changes.length ? `brand-android: updated\n  ${changes.join("\n  ")}` : "brand-android: already up to date");
}
