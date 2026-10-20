#!/usr/bin/env node
/**
 * Harvest the host's own captures of the installed CLI into the heuristics'
 * test fixtures.
 *
 * The host keeps one redacted sample per clihealth signal per CLI version, the
 * first time that signal is seen to WORK (`packages/host/src/clifixtures.ts`,
 * under `<state>/clifixtures/<version>/<signal>.txt|json`). This lists them
 * and, with `--write`, copies each one the repo does not have yet into
 * `packages/host/test/fixtures/screens/harvest-<signal>-<version>.<ext>` and
 * adds its entry to `fixtures/signals.json` — `cli` from the version it was
 * captured on, `role` from running the signal's reader over it
 * (`packages/host/test/signalreaders.mjs`): `match` if it reads, else `guard`.
 *
 * Nothing commits itself. The tool writes files; a person reads the diff. This
 * repo is mirrored public, so before committing, grep the new fixtures for
 * paths, names and secrets — a sample that trips the check below is refused
 * outright, and the check is not the review. (`limit.reset`'s fixture is
 * ROT13'd on disk; the check reads it decoded.)
 *
 *   node tools/harvestfixtures.mjs                 # list what is kept and what --write would do
 *   node tools/harvestfixtures.mjs --write         # copy the new ones in
 *   node tools/harvestfixtures.mjs --dir <path>    # another capture dir
 *   node tools/harvestfixtures.mjs --json
 *
 * Needs `npm run build` (the catalog from packages/shared/dist, the readers
 * from packages/host/dist).
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = join(ROOT, "packages/host/test/fixtures");
const MANIFEST = join(FIXTURES, "signals.json");
const TEST = "packages/host/test/harvested.test.mjs";

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const FILE_RE = /^([a-z]+\.[a-z]+)\.(txt|json)$/;

/**
 * Every capture in a capture dir: `{ id, version, ext, file }`. A version dir
 * that is not a plain `X.Y.Z`, a file that is not `<signal>.<ext>` and a
 * signal the catalog does not have are all skipped and SAID — a capture with a
 * version that cannot be told is no fixture, never a current one.
 */
export function listSamples(dir, known) {
  const samples = [], skipped = [];
  if (!existsSync(dir)) return { samples, skipped };
  for (const version of readdirSync(dir).sort()) {
    const vdir = join(dir, version);
    if (!statSync(vdir).isDirectory()) continue;
    if (!VERSION_RE.test(version)) { skipped.push(`${version}/: not a CLI version`); continue; }
    for (const name of readdirSync(vdir).sort()) {
      const m = FILE_RE.exec(name);
      if (!m || !known.has(m[1])) { skipped.push(`${version}/${name}: not a known signal's capture`); continue; }
      samples.push({ id: m[1], version, ext: m[2], file: join(vdir, name) });
    }
  }
  return { samples, skipped };
}

/**
 * A key or token: a long run with a letter AND a digit that is not a schema
 * key — mixed case, or one unbroken piece of 16+ (`ephemeral_5m_input_tokens`
 * is short words; `toolu_014eSw5Z…` and a hex secret are neither).
 */
export function opaqueRun(text) {
  for (const m of text.matchAll(/[A-Za-z0-9_+=-]{24,}/g)) {
    const r = m[0];
    if (!/\d/.test(r) || !/[A-Za-z]/.test(r) || /^[xX0_+=-]+$/.test(r)) continue;
    if ((/[a-z]/.test(r) && /[A-Z]/.test(r)) || r.split(/[_+=-]/).some((p) => p.length >= 16)) return r;
  }
  return null;
}

/** What would leave this desktop that the redaction exists to keep here. */
export function leaks(text) {
  const out = [];
  if (/\/(?:Users|home)\/[^/\s~<]/.test(text)) out.push("a home directory path");
  if (/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/.test(text)) out.push("an email address");
  if (opaqueRun(text)) out.push("a long opaque run (a key or token?)");
  return out;
}

export const fixturePath = (s) => `screens/harvest-${s.id}-${s.version}.${s.ext}`;

/**
 * One line of the plan per sample: `new` (with the role its reader gives it),
 * `present` (the manifest has that path already), or `refused` (a leak, or no
 * reader for that signal).
 */
export function planHarvest(samples, manifest, { read, readSignal, decode = (_id, t) => t }) {
  const listed = new Set(Object.values(manifest.signals ?? {}).flat().map((e) => e.path));
  return samples.map((s) => {
    const path = fixturePath(s);
    if (listed.has(path)) return { ...s, path, action: "present" };
    const text = read(s.file);
    const leak = leaks(decode(s.id, text));
    if (leak.length) return { ...s, path, action: "refused", why: `carries ${leak.join(", ")}` };
    const hit = readSignal(s.id, text);
    if (hit === null) return { ...s, path, action: "refused", why: "no fixture reader for this signal" };
    return { ...s, path, action: "new", role: hit ? "match" : "guard", text };
  });
}

/** The manifest with the plan's new entries added under their signals. */
export function withEntries(manifest, plan) {
  const next = { ...manifest, signals: { ...(manifest.signals ?? {}) } };
  for (const p of plan.filter((x) => x.action === "new")) {
    next.signals[p.id] = [...(next.signals[p.id] ?? []), { path: p.path, role: p.role, test: TEST, cli: p.version }];
  }
  return next;
}

/** `signals.json` in its own layout: one entry per line, so an addition is a one-line diff. */
export function formatManifest(m) {
  const head = Object.entries(m).filter(([k]) => k !== "signals").map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  const sigs = Object.entries(m.signals ?? {}).map(([id, list]) =>
    `    ${JSON.stringify(id)}: [\n${list.map((e) => `      { ${Object.entries(e).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")} }`).join(",\n")}\n    ]`);
  return `{\n${head.join("\n")}\n  "signals": {\n${sigs.join(",\n")}\n  }\n}\n`;
}

async function stateDir() {
  const { stateDirPick } = await import(pathToFileURL(join(ROOT, "packages/shared/dist/statedir.js")).href);
  return stateDirPick(process.env, homedir()).dir;
}

async function main(argv) {
  const flag = (f) => argv.includes(f);
  const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const catalog = join(ROOT, "packages/shared/dist/clihealth/healthcatalog.js");
  const readers = join(ROOT, "packages/host/test/signalreaders.mjs");
  if (!existsSync(catalog) || !existsSync(join(ROOT, "packages/host/dist/prompt.js"))) {
    console.error("harvestfixtures: packages/shared/dist or packages/host/dist is missing — run `npm run build` first.");
    return 1;
  }
  const { CLI_SIGNALS } = await import(pathToFileURL(catalog).href);
  const { readSignal } = await import(pathToFileURL(readers).href);
  const dir = opt("--dir") ?? join(await stateDir(), "clifixtures");
  const { samples, skipped } = listSamples(dir, new Set(CLI_SIGNALS.map((s) => s.id)));
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const { decodeFixture } = await import(pathToFileURL(join(ROOT, "packages/shared/dist/clihealth.js")).href);
  const plan = planHarvest(samples, manifest, { read: (f) => readFileSync(f, "utf8"), readSignal, decode: decodeFixture });

  if (flag("--json")) {
    console.log(JSON.stringify({ dir, plan: plan.map(({ text, ...p }) => p), skipped }, null, 2));
  } else {
    console.log(`Captures in ${dir}: ${samples.length}`);
    for (const p of plan) {
      const what = p.action === "new" ? `new, as a ${p.role}` : p.action === "refused" ? `refused: ${p.why}` : "already in signals.json";
      console.log(`  ${p.id.padEnd(17)} v${p.version}  ${p.path}  — ${what}`);
    }
    for (const s of skipped) console.log(`  skipped ${s}`);
  }
  const fresh = plan.filter((p) => p.action === "new");
  if (!flag("--write")) {
    if (fresh.length && !flag("--json")) console.log(`\n${fresh.length} new. Re-run with --write to copy them in.`);
    return 0;
  }
  for (const p of fresh) writeFileSync(join(FIXTURES, p.path), p.text);
  if (fresh.length) writeFileSync(MANIFEST, formatManifest(withEntries(manifest, plan)));
  console.log(`\nWrote ${fresh.length} fixture(s) and their signals.json entries. Nothing is staged:`);
  console.log("read the diff, and grep the new files for paths, names and secrets before committing — this repo is mirrored public.");
  for (const p of fresh.filter((x) => x.role === "guard")) {
    console.log(`  note: ${p.path} was captured on a GOOD observation yet its reader does not match it — the cut or the mask lost what the reader needs; check it before keeping it as a guard.`);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
