/**
 * Where the extension keeps one folder's repo-health series: `<storageDir>/<slug>/repohealth.jsonl`.
 * The hash (of the realpath, so two spellings of one folder share a series) keeps it unique; the
 * basename keeps it readable. Every character outside [A-Za-z0-9._-] becomes "-".
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";

export function healthSlug(folder: string): string {
  let real: string;
  try { real = realpathSync(folder); } catch { real = resolve(folder); }
  const hash = createHash("sha1").update(real).digest("hex").slice(0, 16);
  const name = basename(real).replace(/[^A-Za-z0-9._-]/g, "-") || "root";
  return `${hash}-${name}`;
}
