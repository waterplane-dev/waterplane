// node --test: the manifest `files` list — what it accepts, and that a copy leaves tests and node_modules behind.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyExtFiles, extFilesProblem } from "./ext-files-lib.mjs";

test("files: accepts relative folders, refuses escapes and non-arrays", () => {
  assert.equal(extFilesProblem(["cli", "helper"]), null);
  assert.equal(extFilesProblem(["cli/client"]), null);
  for (const bad of [[], "cli", [1], [""], ["../x"], ["/etc"], ["a/../b"], ["a b"]]) assert.match(extFilesProblem(bad), /./, JSON.stringify(bad));
});

/** A throwaway git repo (a hook's GIT_DIR must not leak in) holding `files`, all added. */
function repo(files, extra = () => {}) {
  const src = mkdtempSync(join(tmpdir(), "extfiles-src-"));
  const env = { ...process.env }; for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[k];
  const git = (...a) => execFileSync("git", ["-C", src, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { env, stdio: "pipe" });
  git("init", "-q");
  const base = join(src, "packages/extensions/x");
  for (const f of files) { mkdirSync(dirname(join(base, f)), { recursive: true }); writeFileSync(join(base, f), "x"); }
  extra(base);
  git("add", "-A");
  return src;
}
const dirname = (p) => p.replace(/\/[^/]*$/, "");

test("files: copies the tracked files verbatim, without node_modules, tests or .DS_Store; reports a missing folder", () => {
  const dst = mkdtempSync(join(tmpdir(), "extfiles-dst-"));
  const src = repo(["cli/tool.mjs", "cli/lib/a.mjs", "cli/node_modules/dep/i.js", "cli/test/t.mjs", "cli/lib/a.test.mjs", "cli/.DS_Store", "helper/build.sh"]);
  try {
    const missing = copyExtFiles(src, "x", ["cli", "helper", "gone"], dst);
    assert.deepEqual(missing, ["gone"]);
    const out = join(dst, "packages/extensions/x");
    for (const f of ["cli/tool.mjs", "cli/lib/a.mjs", "helper/build.sh"]) assert.ok(existsSync(join(out, f)), f);
    for (const f of ["cli/node_modules", "cli/test", "cli/lib/a.test.mjs", "cli/.DS_Store"]) assert.ok(!existsSync(join(out, f)), f);
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true }); }
});

test("files: an untracked or gitignored file (a __pycache__) never ships", () => {
  const dst = mkdtempSync(join(tmpdir(), "extfiles-dst-"));
  const src = repo(["cli/tool.mjs", "cli/py/x.py"], (base) => {
    writeFileSync(join(src0(base), ".gitignore"), "__pycache__/\n");
    mkdirSync(join(base, "cli/py/__pycache__"), { recursive: true });
    writeFileSync(join(base, "cli/py/__pycache__/x.cpython-312.pyc"), "x");
  });
  writeFileSync(join(src, "packages/extensions/x/cli/scratch.txt"), "x"); // untracked: added after `git add`
  try {
    copyExtFiles(src, "x", ["cli"], dst);
    const out = join(dst, "packages/extensions/x/cli");
    assert.ok(existsSync(join(out, "tool.mjs")) && existsSync(join(out, "py/x.py")));
    assert.ok(!existsSync(join(out, "py/__pycache__")), "__pycache__ shipped");
    assert.ok(!existsSync(join(out, "scratch.txt")), "an untracked file shipped");
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true }); }
});
const src0 = (base) => base.replace(/\/packages\/extensions\/x$/, "");

test("files: a symlinked folder or file is refused in words", () => {
  const dst = mkdtempSync(join(tmpdir(), "extfiles-dst-"));
  const a = repo(["real/a.mjs"], (base) => symlinkSync(join(base, "real"), join(base, "cli")));
  const b = repo(["cli/a.mjs"], (base) => symlinkSync("/etc/hosts", join(base, "cli/link.mjs")));
  try {
    assert.throws(() => copyExtFiles(a, "x", ["cli"], dst), /cli is a symlink/);
    assert.throws(() => copyExtFiles(b, "x", ["cli"], dst), /link\.mjs is a symlink/);
  } finally { for (const d of [a, b, dst]) rmSync(d, { recursive: true, force: true }); }
});
