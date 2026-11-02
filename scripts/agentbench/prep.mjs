// node scripts/agentbench/prep.mjs <label> <commit> — a clone of the repo at <commit> under WORK/src-<label>,
// with a node_modules shim (the main checkout's packages, this clone's workspaces) and
// shared + host built. Benchmark runs copy it (APFS clone) and boot their host from it.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MAIN = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const WORK = process.env.AGENTBENCH_WORK || join(tmpdir(), "agentbench");
const [label, commit] = process.argv.slice(2);
const dst = join(WORK, `src-${label}`);
rmSync(dst, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const run = (cmd, args, cwd = dst) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
run("git", ["clone", "-q", "--shared", MAIN, dst], WORK);
run("git", ["checkout", "-q", commit]);
run("git", ["config", "user.name", "bench"]);
run("git", ["config", "user.email", "bench@localhost"]);

function shim(from, to) {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from)) {
    const src = join(from, e), dest = join(to, e);
    const st = lstatSync(src);
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(src), dest); // relative workspace links resolve inside the clone
    else if (e.startsWith("@") && st.isDirectory()) shim(src, dest);
    else symlinkSync(src, dest);
  }
}
shim(join(MAIN, "node_modules"), join(dst, "node_modules"));
run("npx", ["tsc", "-p", "packages/shared"]);
run("npm", ["run", "build", "-w", "@waterplane/host"]);
console.log("ready", dst, existsSync(join(dst, "packages/host/dist/main.js")));
