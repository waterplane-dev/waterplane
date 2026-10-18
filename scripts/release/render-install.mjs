#!/usr/bin/env node
/**
 * Render `deploy/install.sh.tmpl` into `dist-release/install.sh`.
 *
 * The installer is POSIX sh and cannot import `brand.ts`, so every name in it
 * is a `@@KEY@@` placeholder filled here from the BUILT brand table
 * (`npm run build:shared` first) — the same reason `deploy/install-service.sh`
 * reads the table at run time. A placeholder left unfilled, or a value that
 * would break out of the template's single quotes, fails the render: a broken
 * installer must never reach `curl | sh`.
 *
 *   node scripts/release/render-install.mjs [--out <file>] [--version <v>]
 *   npm run release:install-sh
 *
 * `--version` defaults to the root package.json's; the installer installs that
 * version unless the person passes their own `--version`. The Node version is
 * `deploy/node-version`, the same pin the release build uses. The release
 * signing key is `deploy/release-pubkey.pem`, carried as one base64 line
 * (`RELEASE_PUBKEY`): the installer refuses any release it did not sign.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { privateExtensions } from "./public-lib.mjs";
import { PUBKEY_PATH, pubkeyLine } from "./sign-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Placeholders whose value is several lines (they sit in a quoted here-doc, never inside a quote). */
const MULTILINE = new Set(["CATALOGUE", "BUILTINS"]);

/** Fill every `@@KEY@@`; throw on an unknown key, a missing one, or an unsafe value. */
export function renderInstall(template, vars) {
  for (const [k, v] of Object.entries(vars)) {
    const bad = MULTILINE.has(k) ? /['\r\\`$]/ : /['\n\r\\`$]/;
    if (typeof v !== "string" || bad.test(v)) {
      throw new Error(`render-install: ${k}=${JSON.stringify(v)} is not safe inside the template's quotes`);
    }
  }
  const missing = new Set();
  const out = template.replace(/@@([A-Z_]+)@@/g, (m, k) => {
    if (!(k in vars)) { missing.add(k); return m; }
    return vars[k];
  });
  if (missing.size) throw new Error(`render-install: no value for ${[...missing].map((k) => `@@${k}@@`).join(", ")}`);
  return out;
}

const PLUGIN_ID = /^[a-z][a-z0-9-]{1,39}$/;
const SAFE_URL = /^(https:\/\/|ssh:\/\/|git@)[A-Za-z0-9._~:\/@%+-]+$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._\/+-]{0,99}$/;
const SAFE_TEXT = /^[^|\n\r\\`$'@"]{1,80}$/;

/**
 * `deploy/plugins.json` as the installer's catalogue: one line per entry,
 * `id|listed(0/1)|experimental(0/1)|repo|ref|name`. Every field is checked
 * against a strict pattern HERE, because the line lands in a shell here-doc
 * and later in a `git clone` argument. A listed entry must carry a real repo
 * and ref: a TODO placeholder never reaches `curl | sh`.
 */
export function catalogueLines(doc) {
  if (!doc || !Array.isArray(doc.plugins)) throw new Error('render-install: deploy/plugins.json needs a "plugins" array');
  const seen = new Set();
  return doc.plugins.map((p) => {
    const where = `deploy/plugins.json plugin ${JSON.stringify(p?.id)}`;
    if (typeof p?.id !== "string" || !PLUGIN_ID.test(p.id)) throw new Error(`render-install: ${where}: id must match ${PLUGIN_ID}`);
    if (seen.has(p.id)) throw new Error(`render-install: ${where}: duplicate id`);
    seen.add(p.id);
    if (typeof p.listed !== "boolean") throw new Error(`render-install: ${where}: "listed" must be true or false`);
    if (typeof p.name !== "string" || !SAFE_TEXT.test(p.name)) throw new Error(`render-install: ${where}: name is missing or has characters the installer cannot carry`);
    if (typeof p.repo !== "string" || !SAFE_URL.test(p.repo)) throw new Error(`render-install: ${where}: repo must be an https://, ssh:// or git@ URL`);
    if (typeof p.ref !== "string" || !SAFE_REF.test(p.ref)) throw new Error(`render-install: ${where}: ref must be a tag or commit (letters, digits, . _ / + -)`);
    if (p.listed && (/TODO/i.test(p.repo) || /TODO/i.test(p.ref))) throw new Error(`render-install: ${where}: is listed but its repo or ref is still a TODO`);
    return [p.id, p.listed ? 1 : 0, p.experimental ? 1 : 0, p.repo, p.ref, p.name].join("|");
  }).join("\n");
}

/**
 * In-repo builtins as `id|optional(0/1)` lines, from each `packages/extensions/<id>/<manifest>`.
 * `skip`: the private ones (`deploy/public-allowlist.txt`), which a published installer never names.
 */
export function builtinLines(root = ROOT, manifest, skip = []) {
  const dir = join(root, "packages/extensions");
  const out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = join(dir, d.name, manifest);
    if (!existsSync(f)) continue;
    const m = JSON.parse(readFileSync(f, "utf8"));
    if (typeof m.id !== "string" || !PLUGIN_ID.test(m.id)) throw new Error(`render-install: ${f}: bad id`);
    if (skip.includes(d.name)) continue;
    out.push(`${m.id}|${m.optional === true ? 1 : 0}`);
  }
  return out.sort().join("\n");
}

/** The extensions the public snapshot leaves out; none in a tree without the allow-list (the public one). */
const privateIds = (root) => {
  const f = join(root, "deploy/public-allowlist.txt");
  return existsSync(f) ? privateExtensions(readFileSync(f, "utf8")) : [];
};

/** The placeholder values for this checkout. */
export async function installVars({ root = ROOT, version } = {}) {
  const { BRAND, PLUGIN_MANIFEST } = await import(join(root, "packages/shared/dist/index.js"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const node = readFileSync(join(root, "deploy/node-version"), "utf8").trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(node)) throw new Error(`render-install: deploy/node-version is "${node}", not x.y.z`);
  const v = (version ?? pkg.version).replace(/^v/, "");
  return {
    SLUG: BRAND.slug,
    NAME: BRAND.name,
    ENV_PREFIX: BRAND.envPrefix,
    NODE_VERSION: node,
    VERSION: v,
    REPO_URL: `https://github.com/${BRAND.githubOrg}/${BRAND.slug}/releases/latest/download`,
    INSTALL_URL: `https://github.com/${BRAND.githubOrg}/${BRAND.slug}/releases/latest/download/install.sh`,
    CONFIG_NAME: BRAND.configDirName,
    STATE_DIR: BRAND.stateDirName,
    CATALOGUE: catalogueLines(JSON.parse(readFileSync(join(root, "deploy/plugins.json"), "utf8"))),
    BUILTINS: builtinLines(root, PLUGIN_MANIFEST, privateIds(root)),
    MANIFEST: PLUGIN_MANIFEST,
    RELEASE_PUBKEY: pubkeyLine(readFileSync(join(root, PUBKEY_PATH), "utf8")),
  };
}

/** Render to `out` (default `dist-release/install.sh`), executable. Returns the path. */
export async function renderInstallFile({ root = ROOT, out, version } = {}) {
  const tmpl = readFileSync(join(root, "deploy/install.sh.tmpl"), "utf8");
  const text = renderInstall(tmpl, await installVars({ root, version }));
  const dest = resolve(root, out ?? "dist-release/install.sh");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text);
  chmodSync(dest, 0o755);
  return dest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  try {
    const dest = await renderInstallFile({ out: opt("--out"), version: opt("--version") });
    console.log(`wrote ${dest}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
