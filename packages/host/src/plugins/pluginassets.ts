/**
 * A plugin's static assets (`manifest.assets`, plugin API 2.0 additive): flat files in a folder
 * inside the extension, served read-only at `GET|HEAD /api/plugin/<id>/asset/<file>` by
 * `routes/apisystem.ts`, behind the core's origin + token gates (not an OPAQUE_READ_ROUTE, not in
 * `passive.ts`). This module is the PURE half: resolve a name to a contained regular file, or refuse
 * in words. The name is flat (`ASSET_NAME`); the assets dir and the file are both realpath-resolved
 * and the file must stay under the dir, so a symlink out is a 404, never a read.
 */
import { realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, sep } from "node:path";

/** A flat file name: no slash, no leading dot, no `..` run can matter without a separator. */
export const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const ASSET_MIME: Record<string, string> = {
  ".wasm": "application/wasm", ".js": "text/javascript", ".gz": "application/gzip", ".json": "application/json",
};
export function assetMime(name: string): string {
  return ASSET_MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
}

export type AssetResult =
  | { ok: true; file: string; size: number; mtimeMs: number; mime: string }
  | { ok: false; status: 403 | 404; error: string };

/** `pluginDir` = the extension folder; `assets` = the manifest value; `name` = the URL's file segment. */
export function resolveAsset(pluginName: string, pluginDir: string, assets: string | undefined, name: string): AssetResult {
  const missing = (error: string): AssetResult => ({ ok: false, status: 404, error });
  if (!assets) return missing(`${pluginName} serves no files`);
  if (!ASSET_NAME.test(name)) return missing(`${pluginName} has no file by that name`);
  if (isAbsolute(assets) || assets.split(/[\\/]/).includes("..")) return missing(`${pluginName} serves no files`);
  try {
    const dir = realpathSync(join(pluginDir, assets));
    if (!(dir === realpathSync(pluginDir) || dir.startsWith(realpathSync(pluginDir) + sep))) return missing(`${pluginName} serves no files`);
    const file = realpathSync(join(dir, name));
    if (!file.startsWith(dir + sep)) return missing(`${pluginName} has no file by that name`);
    const st = statSync(file);
    if (!st.isFile()) return missing(`${pluginName} has no file by that name`);
    return { ok: true, file, size: st.size, mtimeMs: st.mtimeMs, mime: assetMime(name) };
  } catch {
    return missing(`${pluginName} has no file by that name`);
  }
}
