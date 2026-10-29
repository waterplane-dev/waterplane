#!/usr/bin/env node
/**
 * Backend parity matrix: what each registered backend declares, side by side, rendered from the
 * LIVE descriptors (host/dist) into docs/notes/backend-parity.md. A column is a backend, a row a
 * fact (caps, the provider table `facts`, delivery, which source kinds it supplies). `tools/backendparity.test.mjs` fails when
 * the committed doc differs from this render, so a descriptor change cannot land without the table.
 *
 *   node tools/backendparity.mjs            write docs/notes/backend-parity.md
 *   node tools/backendparity.mjs --check    exit 1 if the committed doc is stale
 *   node tools/backendparity.mjs --plugins  print (never write) the same table for the external
 *                                           plugins the daemon would discover (its config dir's plugin list)
 *
 * The committed doc covers core + public in-repo extensions only: an external plugin exists on one machine,
 * and a doc that changed with the machine could never be checked. Needs `npm run build` first.
 */
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "packages/host/dist");
export const DOC = join(ROOT, "docs/notes/backend-parity.md");

const once = (reg) => (name, r) => { try { return reg(name, r); } catch (e) { if (/already exists/.test(String(e?.message))) return () => {}; throw e; } };
const imp = (p) => import(pathToFileURL(p).href);
/** A scratch dir for a plugin's activate(), removed at exit (with-tmp warns on a leak). */
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "backendparity-")); process.on("exit", () => rmSync(d, { recursive: true, force: true })); return d; };
const drop = (d) => rmSync(d, { recursive: true, force: true });

/** Run a plugin's activate() against a capturing api; every other api member is a no-op. */
async function activateInto(hostFile, id, manifest, pluginDescriptor, importHost) {
  const dataDir = scratch();
  const got = [];
  const noop = () => () => {};
  const api = new Proxy({ id, dataDir, stateDir: dataDir, backend: (def) => { got.push(pluginDescriptor(def, id, { ...(manifest.experimental ? { experimental: true } : {}) })); return () => {}; } },
    { get: (t, k) => (k in t ? t[k] : noop) });
  try { await (await importHost(hostFile)).activate(api); } finally { drop(dataDir); } // descriptors only: nothing serves a session
  return got;
}

async function loaders() {
  const [pd, pl, bd] = await Promise.all([imp(join(DIST, "plugins/pluginapi.js")), imp(join(DIST, "plugins/pluginloader.js")), imp(join(DIST, "branddirs.js"))]);
  return { pluginDescriptor: pd.pluginDescriptor, readPluginDir: pl.readPluginDir, discoverPluginDirs: pl.discoverPluginDirs, importHost: pl.importHost, configDir: bd.configDir };
}

/**
 * Core backends, then every in-repo extension that declares backends (found by folder, never by
 * name) — minus the PRIVATE ones (`deploy/public-allowlist.txt`). The public snapshot does not
 * carry their folders, so a column for one would make the committed doc a render no public tree
 * can reproduce: 0.1.5 and 0.1.6 shipped an opencode column and a test that failed on it.
 */
export async function loadInRepo() {
  const reg = await imp(join(DIST, "backends/index.js"));
  const { pluginDescriptor, readPluginDir, importHost } = await loaders();
  const { privateExtensions } = await imp(join(ROOT, "scripts/release/public-lib.mjs"));
  const allow = join(ROOT, "deploy/public-allowlist.txt");
  const hidden = new Set(existsSync(allow) ? privateExtensions(readFileSync(allow, "utf8")) : []);
  const out = [...reg.BACKENDS];
  const base = join(ROOT, "packages/extensions");
  for (const ext of readdirSync(base).sort()) {
    if (hidden.has(ext)) continue;
    const dir = join(base, ext);
    const hostFile = join(DIST, "extensions", ext, "host/index.mjs");
    const pd = readPluginDir(dir, "in-repo", { hostFile });
    if (pd.problems.length || !pd.manifest.backends?.length || !existsSync(hostFile)) continue;
    out.push(...(await activateInto(hostFile, ext, pd.manifest, pluginDescriptor, importHost)));
  }
  return out;
}

/** External plugins from the config dir's plugin list. Missing / failing ones give a note. */
export async function loadExternal() {
  const { pluginDescriptor, readPluginDir, discoverPluginDirs, importHost, configDir } = await loaders();
  const { dirs, problems } = discoverPluginDirs(configDir());
  const out = [], notes = problems.map((p) => String(p));
  for (const { dir, source } of dirs) {
    const pd = readPluginDir(dir, source);
    if (pd.problems.length || !pd.hostFile) { notes.push(`${source}: not installed here (${pd.problems[0] ?? "no host module"})`); continue; }
    if (!pd.manifest.backends?.length) continue;
    try { out.push(...(await activateInto(pd.hostFile, pd.manifest.id, pd.manifest, pluginDescriptor, importHost))); }
    catch (e) { notes.push(`${source}: failed to load (${String(e?.message ?? e).split("\n")[0]})`); }
  }
  return { descriptors: out, notes };
}

export const cell = (v) => {
  if (v === undefined || v === null) return "n/a";
  if (v === true) return "yes";
  if (v === false) return "no";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "none";
  if (typeof v === "object") return Object.entries(v).map(([k, x]) => `${k}=${cell(x)}`).join(", ");
  return String(v).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
};
const has = (v) => (v ? "yes" : "no");
/** One provider list as the table reads it: `source`, `screen:<reader>`, `store:<reader>`, first wins. */
const providers = (list) => (list === undefined ? undefined
  : list.length ? list.map((p) => (p.source ? "source" : p.screen ? `screen:${p.screen}` : p.store ? `store:${p.store}` : "?")).join(" → ") : "none");
/** Contract 2.0's fact names, read from shared/dist so a new fact grows a row by itself. */
const { FACT_NAMES } = await imp(join(ROOT, "packages/shared/dist/index.js"));
const { derive } = await imp(join(DIST, "backends/derive.js"));
/** One optional wire cap as the frame sends it: `yes`, or `absent` (never `no` — the wire never says false). */
const wireCap = (d, k) => (k in derive(d).wireCaps() ? cell(derive(d).wireCaps()[k]) : "absent");

function facts(d) {
  const c = d.caps ?? {}, dl = d.delivery ?? {}, s = d.sources, f = d.facts ?? {};
  return [
    ["Declares", [
      ["label", d.label], ["experimental", d.experimental], ["plugin", d.plugin],
      ["healthScope", d.healthScope], ["localRunner", d.localRunner],
    ]],
    ["Caps", [
      ["turns", c.turns], ["slash", c.slash], ["effort", c.effort], ["permissionModes", c.permissionModes], ["launchModes", c.launchModes],
      ["remoteControl", c.remoteControl], ["forkVia", d.forkVia], ["measured.versions", d.measured?.versions],
    ]],
    ["Facts (providers, first that answers wins)", FACT_NAMES.map((n) => [n, providers(f[n])])],
    ["Delivery", [
      ["submitKey", JSON.stringify(dl.submitKey ?? null)], ["requiresChannel", dl.requiresChannel],
      ["textThenSubmitDelayMs", dl.textThenSubmitDelayMs], ["pastePlaceholder", has(dl.pastePlaceholder)],
      ["composerCursorRe", has(dl.composerCursorRe)], ["composerRuleRe", has(dl.composerRuleRe)],
      ["composerPlaceholderRe", has(dl.composerPlaceholderRe)], ["trustPromptRe", has(dl.trustPromptRe)],
    ]],
    ["Sources (provider kinds)", [
      ["any source", s ? "yes" : "no"], ["inBand", s?.inBand], ["turns", has(s?.turns)], ["dialogs", has(s?.dialogs)],
      ["delivery", has(s?.delivery)], ["transcript", has(s?.transcript)], ["context", has(s?.context)],
      ["tokens", has(s?.tokens)], ["sweep", has(s?.sweep)],
      // 2.2 slots (`docs/plans/backend-parity-v3.md` §7)
      ["mode", has(s?.mode)], ["commands", has(s?.commands)],
      ["tokens.session", has(typeof s?.tokens?.session === "function")],
      ["context.compactions", has(typeof s?.context?.compactions === "function")],
      // consumed by `routes/session.ts` (`convfork.ts`'s `forkViaSource`, P4b2)
      ["conversations.fork", has(typeof s?.conversations?.fork === "function")],
    ]],
    // What the phone is told (`derive.ts`'s `wireCaps()`): an optional cap is ABSENT unless a provider answers.
    ["Wire caps (2.2, absent unless a source answers; `fork` always sent)", [
      ["modes", wireCap(d, "modes")], ["commands", wireCap(d, "commands")],
      // claude's file copy, `forkVia: "server"`, or the source's own `conversations.fork`
      ["fork", wireCap(d, "fork")],
    ]],
  ];
}

/** The table. Pure: descriptors in, markdown out. */
export function render(descriptors, { notes = [], header = true } = {}) {
  const ids = descriptors.map((d) => d.id);
  const lines = [];
  if (header) {
    lines.push(
      "# Backend parity",
      "",
      "GENERATED by `node tools/backendparity.mjs` from the live backend descriptors (core and in-repo",
      "extensions) — do not edit; `tools/backendparity.test.mjs` fails when this file is stale. External",
      "plugins are not in this file (they differ per machine): `node tools/backendparity.mjs --plugins`.",
      "A cell reads `n/a` when the descriptor does not declare the fact (yet).",
      "",
    );
  }
  lines.push(`| fact | ${ids.map((i) => `\`${i}\``).join(" | ")} |`, `|---|${ids.map(() => "---").join("|")}|`);
  const all = descriptors.map(facts);
  (all[0] ?? []).forEach(([group, rows], gi) => {
    lines.push(`| **${group}** |${ids.map(() => "").join("|")}|`);
    rows.forEach(([name], i) => lines.push(`| ${name} | ${all.map((f) => cell(f[gi][1][i][1])).join(" | ")} |`));
  });
  if (notes.length) lines.push("", ...notes.map((n) => `- ${n}`));
  return lines.join("\n") + "\n";
}

export async function renderDoc() { return render(await loadInRepo()); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (arg === "--plugins") {
    const { descriptors, notes } = await loadExternal();
    process.stdout.write(descriptors.length ? render(descriptors, { notes, header: false }) : notes.map((n) => `- ${n}\n`).join(""));
    process.exit(0);
  }
  const text = await renderDoc();
  if (arg === "--check") {
    const cur = existsSync(DOC) ? readFileSync(DOC, "utf8") : "";
    if (cur !== text) { console.error("docs/notes/backend-parity.md is stale: run `node tools/backendparity.mjs`"); process.exit(1); }
  } else writeFileSync(DOC, text);
  process.exit(0);
}
