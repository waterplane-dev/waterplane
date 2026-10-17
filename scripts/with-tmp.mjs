// Run a command with TMPDIR pointed at ONE fresh per-run dir, removed at the end.
//
//   node scripts/with-tmp.mjs <command> [args…]
//
// Whatever a test leaves under the temp dir then dies with the run instead of
// accumulating in the system temp dir. The dir is SHORT (/tmp/wpt-xxxxxx): a
// tmux socket path caps near 104 bytes on macOS, and tmpdir() there is a long
// /var/folders/… path. After the command, entries still in the dir are reported
// by name prefix — a warning, never a failure — and dirs the `lib-testtmp.mjs`
// preload had to sweep up for a test that did not are listed too.
// `WATERPLANE_KEEP_TEST_TMP=1` keeps the dir when the command FAILED.
//
// The dir is the ONLY thing this script ever deletes, and it is deleted whatever
// is left in it: the listing is a pointer for fixing a test, not a condition.
// Removal retries and, if a tree has read-only dirs, makes them writable first;
// if the dir still stands the run says so. A wrapper that is killed outright
// (SIGKILL, a harness timeout) cannot clean up, so each dir carries a `.pid` and
// the NEXT run removes dirs of this user whose pid is gone, never a live one.
// `WP_TMP_BASE` moves the parent dir (tests only).
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { E } from "./lib-brand.mjs";

const cmd = process.argv.slice(2);
if (!cmd.length) { console.error("usage: with-tmp.mjs <command> [args…]"); process.exit(2); }

const base = process.env.WP_TMP_BASE || (existsSync("/tmp") ? "/tmp" : tmpdir());

/** Remove `d` — only ever a `wpt-*` child of `base`. True when it is gone. */
function removeRunDir(d) {
  if (dirname(d) !== base || !basename(d).startsWith("wpt-")) return false;
  const rm = () => rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  try { rm(); } catch { /* fall through to the chmod retry */ }
  if (existsSync(d)) {
    unlock(d);
    try { rm(); } catch { /* reported by the caller */ }
  }
  return !existsSync(d);
}
/** Make a tree writable so a 0555 directory cannot hold its own removal up. Never follows a symlink. */
function unlock(p) {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      chmodSync(p, 0o700);
      for (const n of readdirSync(p)) unlock(join(p, n));
    }
  } catch { /* gone or not ours */ }
}
/** Dirs of a wrapper that was killed outright: `.pid` names a process that no longer exists. */
function reapDead() {
  let names = [];
  try { names = readdirSync(base).filter((n) => n.startsWith("wpt-")); } catch { return; }
  for (const n of names) {
    const d = join(base, n);
    try {
      if (!lstatSync(d).isDirectory() || lstatSync(d).uid !== process.getuid?.()) continue;
      const pid = Number(readFileSync(join(d, ".pid"), "utf8"));
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try { process.kill(pid, 0); continue; } catch (e) { if (e.code !== "ESRCH") continue; }
      removeRunDir(d);
    } catch { /* no .pid yet (a run starting right now) or unreadable: leave it */ }
  }
}
reapDead();
const dir = mkdtempSync(join(base, "wpt-"));
writeFileSync(join(dir, ".pid"), String(process.pid));
const swept = join(dir, ".swept");
const env = { ...process.env, TMPDIR: dir, TEMP: dir, TMP: dir, WP_TMP_SWEPT: swept };

/** `waterplane-ctxlog-AbC123` -> `waterplane-ctxlog-`. A runtime's extracted
 *  native lib (`.3bdfde8f0577dff0-00000000.dylib`, one per process that loads
 *  it — no test of ours makes these) is hash-named, so it buckets by extension
 *  or a single run lists hundreds of one-offs. */
const prefixOf = (n) => /^\.[0-9a-f]{16}-[0-9a-f]{8}\.\w+$/.test(n)
  ? n.replace(/^\.[^.]+/, ".<hash>")
  : n.replace(/[A-Za-z0-9]{6}$/, "").replace(/-?$/, "-");
function tally(names) {
  const m = new Map();
  for (const n of names) m.set(prefixOf(n), (m.get(prefixOf(n)) || 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).map(([p, c]) => `${p}* x${c}`).join(", ");
}

const child = spawn(cmd[0], cmd.slice(1), { env, stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));

child.on("error", (e) => { console.error(`[with-tmp] cannot run ${cmd[0]}: ${e.message}`); finish(127); });
child.on("close", (code, sig) => finish(code ?? (sig ? 1 : 0)));

function finish(code) {
  let sweptNames = [];
  try { sweptNames = readFileSync(swept, "utf8").split("\n").filter(Boolean); } catch { /* none */ }
  let left = [];
  try { left = readdirSync(dir).filter((n) => n !== ".swept" && n !== ".pid" && !n.startsWith("tsx-")); } catch { /* gone */ }
  if (sweptNames.length) console.warn(`[with-tmp] WARNING: ${sweptNames.length} temp dir(s) were not removed by their test (swept by the preload): ${tally(sweptNames)}`);
  if (left.length) console.warn(`[with-tmp] WARNING: ${left.length} entr${left.length === 1 ? "y" : "ies"} left in the run's temp dir (removed with it): ${tally(left)}`);
  if (code !== 0 && process.env[E.KEEP_TEST_TMP] === "1") {
    console.warn(`[with-tmp] run failed; keeping ${dir}`);
  } else {
    if (!removeRunDir(dir)) console.warn(`[with-tmp] WARNING: could not remove ${dir}; delete it by hand`);
  }
  process.exit(code);
}
