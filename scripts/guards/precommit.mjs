// git pre-commit: the `commit` tier of `guards.mjs`, over EXACTLY what is being
// committed. Installed by ~/.local-ci/install.sh (steps/<repo>.pre-commit), next
// to the pre-push gate it front-runs.
//
// It never reads the working tree. Several sessions edit this checkout at once,
// so the tree holds other people's unfinished work, and a commit that failed on
// THAT would block an innocent commit and teach everyone `--no-verify`. The
// index (GIT_INDEX_FILE, which git points at a temp index for `commit -a` and
// partial commits) is exported to a temp dir and the guards run there.
//
// Only guards whose inputs the staged change touches run; a commit that touches
// none of them costs one `git diff`. The guards here read files only — anything
// needing a build, git history or a server stays at push.
//
// Bypass once: git commit --no-verify (or SKIP_LOCAL_CI=1).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatFailure, guardsFor, runGuards } from "./guards.mjs";

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...opts });
}

/** Borrow the checkout's installed deps; an export has none and guards may import one. */
function borrowDeps(root, into) {
  const link = (rel) => {
    const from = join(root, rel);
    if (existsSync(from) && !existsSync(join(into, rel))) symlinkSync(from, join(into, rel), "dir");
  };
  link("node_modules");
  for (const p of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    if (p.isDirectory() && existsSync(join(into, "packages", p.name))) link(join("packages", p.name, "node_modules"));
  }
  // Built, gitignored, and imported by scripts/ (`lib-brand.mjs` → `shared/dist/brand.js`): without
  // it every guard that spawns the stub TUI fails on an export, whatever the change.
  link(join("packages", "shared", "dist"));
}

function main() {
  if (process.env.SKIP_LOCAL_CI === "1") return 0;
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  const staged = git(["diff", "--cached", "--name-only", "-z"], { cwd: root }).split("\0").filter(Boolean);
  const tests = guardsFor(staged, "commit", root);
  if (!tests.length) return 0;

  const t0 = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "wp-precommit-"));
  try {
    git(["checkout-index", "-a", `--prefix=${dir}/`], { cwd: root });
    borrowDeps(root, dir);
    // Nothing inside may talk to the real repository: an exported tree has no
    // .git, and a GIT_DIR inherited from the hook would point a guard's git
    // calls at this repo's object store and refs.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
    const failures = runGuards(tests, dir, env);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (!failures.length) {
      process.stdout.write(`pre-commit: ${tests.length} guard file(s) over the staged tree, ok (${secs}s)\n`);
      return 0;
    }
    process.stderr.write(
      `pre-commit: a repo guard fails on what you are committing (${secs}s). Commit refused.\n\n` +
      failures.map(formatFailure).join("\n\n") +
      `\n\nThese ran over the STAGED files only. Bypass once: git commit --no-verify\n`,
    );
    return 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exitCode = main();
