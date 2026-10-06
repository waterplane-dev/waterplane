/**
 * The in-repo extensions: `packages/extensions/<id>/` — the plugin manifest,
 * `host/`, `web/` and `shared/`. DISCOVERED, not listed: every folder there
 * whose manifest names a `host` module, in id order, loaded by the registry
 * before any external plugin and always on (docs/notes/plugins.md, "In-repo
 * extensions"). Discovered so that an extension's presence or absence is a
 * folder and never a core edit — the public snapshot leaves the private ones
 * out (`deploy/public-allowlist.txt`) and core must neither name nor miss them.
 *
 * Where each host half is imported from depends on how the daemon runs, and
 * `dist/main.js` must not move for it:
 * - built (`dist/plugins/builtin.js`): `packages/host/tsconfig.extensions.json`
 *   compiles `packages/extensions/<id>/host/*.mts` into
 *   `packages/host/dist/extensions/<id>/host/`, a second `tsc` in the host's
 *   `build` script;
 * - dev under tsx (`src/plugins/builtin.ts`): the `.mts` source itself.
 * `.mts` because `packages/extensions/` is deliberately not a package (no
 * package.json to say `"type": "module"`), and a `.ts` there compiles to
 * CommonJS, where `import.meta` does not exist.
 * The manifest is read from the source folder in both cases.
 *
 * An extension whose manifest says `optional` (opencode) may be switched off by
 * the person, and a release may leave it out altogether: `deploy/ship.json`
 * decides, and `scripts/release/build.mjs` writes the outcome into the
 * install's `release.json` as `builtins: { <id>: { on, experimental? } }` —
 * every builtin the tarball carries, with its default switch. A dev checkout
 * has no `release.json`: everything here loads, and an optional one starts on.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PLUGIN_MANIFEST, type HostPluginModule, type PluginDoctorCheck } from "@waterplane/shared";


/** `packages/extensions/` — the same two levels up from `src/plugins/` and `dist/plugins/`. */
const EXT_ROOT = fileURLToPath(new URL("../../../extensions/", import.meta.url));
const FROM_SOURCE = import.meta.url.endsWith(".ts");

/**
 * The extensions under `root` that have a host half: a folder whose manifest parses and names a
 * `host` module. Sorted by id, so the load order is a fact about the folder names and not about
 * the order a directory listing happened to return. A folder with no manifest, or a manifest that
 * does not parse, is not an extension here (the registry lists a broken one only when it was
 * asked for by name — `plugin-paths.json`).
 */
export function discoverBuiltins(root: string = EXT_ROOT): string[] {
  let names: string[];
  try { names = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { return []; }
  return names.filter((id) => {
    const file = join(root, id, PLUGIN_MANIFEST);
    if (!existsSync(file)) return false;
    try { return typeof (JSON.parse(readFileSync(file, "utf8")) as { host?: unknown } | null)?.host === "string"; }
    catch { return false; }
  }).sort();
}

export const BUILTIN_EXTENSIONS: readonly string[] = discoverBuiltins();

/** What a release says about its builtins; null in a dev checkout (or an older release without the key). */
export type ReleaseBuiltins = Record<string, { on: boolean }>;

/** The install root's `release.json` — the same two levels up from `packages/extensions/`. */
const RELEASE_JSON = fileURLToPath(new URL("../../../../release.json", import.meta.url));

export function releaseBuiltins(path: string = RELEASE_JSON): ReleaseBuiltins | null {
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  const b = (doc as { builtins?: unknown } | null)?.builtins;
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const out: ReleaseBuiltins = {};
  for (const [id, v] of Object.entries(b as Record<string, unknown>)) {
    out[id] = { on: !(v && typeof v === "object" && (v as { on?: unknown }).on === false) };
  }
  return out;
}

/** The builtins this install carries: all of them, unless its release names which. */
export function shippedBuiltins(rel: ReleaseBuiltins | null = releaseBuiltins()): string[] {
  return BUILTIN_EXTENSIONS.filter((id) => !rel || id in rel);
}


export function builtinDir(id: string): string {
  return join(EXT_ROOT, id);
}

export function builtinHostModule(id: string): string {
  return FROM_SOURCE
    ? join(EXT_ROOT, id, "host", "index.mts")
    : fileURLToPath(new URL(`../extensions/${id}/host/index.mjs`, import.meta.url));
}

/**
 * The preflight lines the in-repo extensions contribute (`HostPluginModule.doctor`), in
 * `shippedBuiltins()` order. Asked WITHOUT `activate` — the doctor loads no plugin — so a builtin's
 * `doctor` stands alone. A module that has no `doctor`, or whose `doctor` throws, contributes
 * nothing. One this install SHIPS but cannot import is a `warn` line naming it: a release that
 * carried the manifest without the compiled code loaded neither extension, and the only place that
 * said so was a boot log line nobody reads.
 */
export async function builtinDoctorChecks(usedBackends: readonly string[]): Promise<PluginDoctorCheck[]> {
  const out: PluginDoctorCheck[] = [];
  for (const id of shippedBuiltins()) {
    const file = builtinHostModule(id);
    let mod: Partial<HostPluginModule>;
    try { mod = (await import(pathToFileURL(file).href)) as Partial<HostPluginModule>; }
    catch (e) {
      const why = existsSync(file) ? (e as Error).message : `${file} is missing`;
      out.push({ id: `extension-${id}`, status: "warn", detail: `built-in extension ${id} did not load: ${why}`, fix: "reinstall this release; the install is incomplete" });
      continue;
    }
    try {
      if (typeof mod.doctor !== "function") continue;
      const lines = await mod.doctor({ usedBackends });
      if (Array.isArray(lines)) out.push(...lines.filter((c) => c && typeof c.id === "string" && typeof c.detail === "string"));
    } catch { /* nothing from this one */ }
  }
  return out;
}
