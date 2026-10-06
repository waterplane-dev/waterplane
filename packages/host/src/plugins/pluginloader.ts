/**
 * Where plugins come from, and reading one off disk (docs/notes/plugins.md,
 * "Where plugins come from").
 *
 * - every directory under `<config dir>/plugins/`, and
 * - every path in `<config dir>/plugin-paths.json` (`{ "paths": ["~/dev/x"] }`),
 *   `~` expanded, relative paths against the config dir. That file used to be
 *   called `plugins.json` — the same name as the STATE dir's `{enabled}` switches
 *   (`pluginregistry.ts`), two files nobody could tell apart by name. An old one
 *   is renamed once, on boot, and read; never deleted (`migratePluginPaths`).
 *
 * Nothing here is skipped in silence: a listed path that is missing, a
 * manifest that does not parse or validate, a host module that is absent or
 * outside its directory — each comes back as a `PluginDir` with `problems`,
 * which the registry lists as `state: "error"` with the reason verbatim.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LEGACY_PLUGIN_MANIFESTS, LEGACY_PLUGIN_PATHS_FILE, manifestProblems, PLUGIN_API_VERSION, PLUGIN_MANIFEST, PLUGIN_PATHS_FILE } from "@waterplane/shared";
import type { HostPluginModule, PluginManifest } from "@waterplane/shared";
import { contained } from "../paths.js";
import { expandHome } from "../pathx.js";

/** One candidate plugin directory, read. `problems` empty ⇒ loadable. */
export interface PluginDir {
  dir: string;
  /** What the phone shows as "where it came from". */
  source: string;
  /** The manifest when it validated; otherwise a stub good enough to list. */
  manifest: PluginManifest;
  hostFile: string | null;
  problems: string[];
  /** Read from a past brand's manifest file name: it still loads, and the registry says to rename it. */
  manifestLegacy?: boolean;
}

const expand = (p: string, base: string): string => {
  const t = expandHome(p);
  return isAbsolute(t) ? t : resolve(base, t);
};

const real = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };

/**
 * Which file lists the plugin paths, after moving an old `plugins.json` to
 * `plugin-paths.json` once. Never loses the old file: it is RENAMED, and only
 * when the new name is free; a rename that fails reads the old file in place.
 * An old file holding only `{ "enabled": … }` is the state dir's switch file in
 * a setup where both dirs are one, and is left alone. Both names present ⇒ the
 * new one is read and the old one is named as ignored.
 */
export function migratePluginPaths(configDir: string): { file: string | null; problems: string[]; notes: string[] } {
  const file = join(configDir, PLUGIN_PATHS_FILE);
  const old = join(configDir, LEGACY_PLUGIN_PATHS_FILE);
  const problems: string[] = [];
  const notes: string[] = [];
  const current = existsSync(file) ? file : null;
  if (!existsSync(old)) return { file: current, problems, notes };
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(old, "utf8")); } catch { doc = undefined; }
  const o = doc && typeof doc === "object" && !Array.isArray(doc) ? doc as Record<string, unknown> : null;
  if (o && !("paths" in o) && "enabled" in o) return { file: current, problems, notes };
  if (current) {
    problems.push(`${old} is ignored: the plugin paths are read from ${file} now — move any path only the old file lists across, then delete it`);
    return { file, problems, notes };
  }
  try {
    renameSync(old, file);
    notes.push(`renamed ${old} to ${file} (the plugin paths file's new name)`);
    return { file, problems, notes };
  } catch (e) {
    problems.push(`could not rename ${old} to ${file} (${(e as Error).message}); reading it under the old name`);
    return { file: old, problems, notes };
  }
}

/**
 * The candidate directories, in a stable order (the plugins dir sorted, then
 * `plugin-paths.json` in its own order), deduplicated by real path. A problem
 * with that file itself is returned, naming it, so it can be said.
 */
export function discoverPluginDirs(configDir: string): { dirs: { dir: string; source: string }[]; problems: string[]; notes: string[] } {
  const out: { dir: string; source: string }[] = [];
  const seen = new Set<string>();
  const push = (dir: string, source: string) => {
    const r = real(dir);
    if (seen.has(r)) return;
    seen.add(r);
    out.push({ dir, source });
  };
  const pdir = join(configDir, "plugins");
  try {
    for (const name of readdirSync(pdir).sort()) {
      if (name.startsWith(".")) continue;
      const d = join(pdir, name);
      try { if (statSync(d).isDirectory()) push(d, d); } catch { /* a dangling link lists as missing below */ push(d, d); }
    }
  } catch { /* no plugins dir — nothing installed that way */ }
  const { file: listFile, problems, notes } = migratePluginPaths(configDir);
  if (listFile) {
    try {
      const doc = JSON.parse(readFileSync(listFile, "utf8"));
      const paths = doc && Array.isArray(doc.paths) ? doc.paths : null;
      if (!paths) problems.push(`${listFile}: expected { "paths": [ … ] }`);
      for (const p of paths ?? []) {
        if (typeof p !== "string" || !p.trim()) { problems.push(`${listFile}: a path is not a string`); continue; }
        push(expand(p.trim(), configDir), p.trim());
      }
    } catch (e) {
      problems.push(`${listFile} is not valid JSON: ${(e as Error).message}`);
    }
  }
  return { dirs: out, problems, notes };
}

/** A manifest-shaped stub for a plugin that cannot be read, so it can still be listed. */
function stub(dir: string, raw: unknown): PluginManifest {
  const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const id = typeof o.id === "string" && o.id ? o.id : basename(dir).toLowerCase();
  return {
    id, name: typeof o.name === "string" && o.name.trim() ? o.name : basename(dir),
    version: typeof o.version === "string" ? o.version : "?",
    apiVersion: typeof o.apiVersion === "number" || typeof o.apiVersion === "string" ? o.apiVersion : PLUGIN_API_VERSION,
    ...(typeof o.description === "string" ? { description: o.description } : {}),
  };
}

/**
 * The compiled siblings a TypeScript host module may have been shipped as, in preference order:
 * `host/index.mts` → `host/index.mjs`, `host/index.js`. A plugin built for distribution carries
 * only `tsc`'s output while its manifest still names the source.
 */
export function compiledSiblings(rel: string): string[] {
  const m = /\.m?ts$/.exec(rel);
  if (!m) return [];
  const stem = rel.slice(0, -m[0].length);
  return [`${stem}.mjs`, `${stem}.js`];
}

/**
 * Read and validate one plugin directory. Never throws.
 *
 * `opts.hostFile` is where the host module REALLY lives when that is not beside the manifest — an
 * in-repo extension in a release, whose manifest stays in `packages/extensions/<id>/` while its
 * compiled code is in `packages/host/dist/extensions/<id>/host/` (`builtin.ts`'s
 * `builtinHostModule`). The caller computed that path itself, so it is checked for existence only;
 * the manifest's own `host` is still held to the plugin directory first.
 */
export function readPluginDir(dir: string, source: string, opts: { hostFile?: string } = {}): PluginDir {
  if (!existsSync(dir)) return { dir, source, manifest: stub(dir, null), hostFile: null, problems: [`${dir} does not exist`] };
  // The current manifest name first, then each past brand's (newest first).
  const names = [PLUGIN_MANIFEST, ...LEGACY_PLUGIN_MANIFESTS];
  const found = names.find((n) => existsSync(join(dir, n)));
  const manifestLegacy = found !== undefined && found !== PLUGIN_MANIFEST;
  const mf = join(dir, found ?? PLUGIN_MANIFEST);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(mf, "utf8")); } catch (e) {
    const why = found ? `${found} is not valid JSON: ${(e as Error).message}` : `no ${PLUGIN_MANIFEST} in that directory`;
    return { dir, source, manifest: stub(dir, null), hostFile: null, problems: [why] };
  }
  const problems = manifestProblems(raw);
  if (problems.length) return { dir, source, manifest: stub(dir, raw), hostFile: null, problems, ...(manifestLegacy ? { manifestLegacy } : {}) };
  const manifest = raw as PluginManifest;
  const rel = typeof manifest.host === "string" && manifest.host ? manifest.host : "host.mjs";
  const hostFile = contained(dir, rel);
  if (!hostFile) return { dir, source, manifest, hostFile: null, problems: [`host "${rel}" is outside the plugin directory`], ...(manifestLegacy ? { manifestLegacy } : {}) };
  const legacy = manifestLegacy ? { manifestLegacy } : {};
  if (opts.hostFile) {
    if (!existsSync(opts.hostFile)) return { dir, source, manifest, hostFile: null, problems: [`host module ${rel} is missing (looked for ${opts.hostFile})`], ...legacy };
    return { dir, source, manifest, hostFile: opts.hostFile, problems: [], ...legacy };
  }
  if (existsSync(hostFile)) return { dir, source, manifest, hostFile, problems: [], ...legacy };
  // The source is absent: its compiled sibling, held to the same directory.
  for (const alt of compiledSiblings(rel)) {
    const f = contained(dir, alt);
    if (f && existsSync(f)) return { dir, source, manifest, hostFile: f, problems: [], ...legacy };
  }
  return { dir, source, manifest, hostFile: null, problems: [`host module ${rel} is missing`], ...legacy };
}

/** Import a host module and check its shape. Throws the reason in words. */
export async function importHost(hostFile: string): Promise<HostPluginModule> {
  const mod: any = await import(pathToFileURL(hostFile).href);
  const m = mod && typeof mod.activate === "function" ? mod
    : mod?.default && typeof mod.default.activate === "function" ? mod.default : null;
  if (!m) throw new Error("the host module exports no activate() function");
  return m as HostPluginModule;
}
