// An in-repo extension's manifest may name extra folders that ship verbatim beside it:
//   "files": ["cli", "helper"]
// (a command line, a native helper — code the host does not compile). Copied from the SOURCE folder
// into the same place in the release tree. Never node_modules, never tests: a shipped folder is what
// a user runs, not what the repo checks it with. Only files git TRACKS ship (a gitignored `__pycache__`
// or a local scratch file never does), and a symlink is refused in words: a copied link points outside
// the release tree.
import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const SEGMENT = /^[A-Za-z0-9._-]+$/;
const SKIP_NAME = /^(node_modules|test|tests|__tests__|\.git|\.DS_Store)$|__pycache__|\.tsbuildinfo$|\.pyc$|\.test\.(m?js|d\.ts|mts|ts)$/;

/** A sentence naming what is wrong with a manifest `files` value, or null when it is usable. */
export function extFilesProblem(files) {
  if (!Array.isArray(files) || files.length === 0) return "must be a non-empty array of folder names";
  for (const f of files) {
    if (typeof f !== "string" || !f) return "holds a non-string entry";
    const parts = f.split("/");
    if (f.startsWith("/") || parts.some((p) => p === "." || p === ".." || !SEGMENT.test(p))) return `entry "${f}" must be a relative folder path inside the extension (no "..", no leading "/")`;
  }
  return null;
}

/** Drop node_modules, test folders and files, build stamps and bytecode: true when this NAME may ship. */
export const extFilesFilter = (src) => !SKIP_NAME.test(src.split("/").pop() ?? "");

const lstatOrNull = (p) => { try { return lstatSync(p); } catch { return null; } };

/** git's own environment (a hook's GIT_DIR) must not redirect a listing of THIS tree. */
const cleanEnv = () => { const e = { ...process.env }; for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete e[k]; return e; };

/** The files git tracks under `rel` (a path inside `srcRoot`), relative to `srcRoot`. */
function trackedUnder(srcRoot, rel) {
  try {
    return execFileSync("git", ["-C", srcRoot, "ls-files", "-z", "--", rel], { encoding: "utf8", env: cleanEnv(), maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  } catch (e) {
    throw new Error(`release: cannot list the tracked files of ${rel} (git ls-files failed in ${srcRoot}: ${String(e.message).split("\n")[0]}). The release builds from a git checkout.`);
  }
}

/**
 * Copy each folder of `files` from `<srcRoot>/packages/extensions/<id>/` to the same place under
 * `destBase`: the files `git ls-files` lists there, minus the skipped names. Returns the entries that
 * do not exist (the caller stops the build in words). Throws, in words, on a symlinked folder or file.
 */
export function copyExtFiles(srcRoot, id, files, destBase) {
  const missing = [];
  for (const f of files) {
    const rel = `packages/extensions/${id}/${f}`;
    const from = join(srcRoot, rel);
    const st = lstatOrNull(from);
    if (st?.isSymbolicLink()) throw new Error(`release: ${rel} is a symlink — a copied link would point outside the release tree. Replace it with the real folder, then build the release again.`);
    if (!st || !st.isDirectory()) { missing.push(f); continue; }
    const listed = trackedUnder(srcRoot, rel);
    if (listed.length === 0) { missing.push(f); continue; }
    for (const path of listed) {
      if (path.split("/").some((seg) => !extFilesFilter(seg))) continue;
      const src = join(srcRoot, path);
      const fs = lstatOrNull(src);
      if (!fs) continue; // tracked but deleted in this tree
      if (fs.isSymbolicLink()) throw new Error(`release: ${path} is a symlink — a copied link would point outside the release tree. Replace it with the real file, then build the release again.`);
      const to = join(destBase, path);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(src, to);
    }
  }
  return missing;
}
