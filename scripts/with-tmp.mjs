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
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E } from "./lib-brand.mjs";

const cmd = process.argv.slice(2);
if (!cmd.length) { console.error("usage: with-tmp.mjs <command> [args…]"); process.exit(2); }

const base = existsSync("/tmp") ? "/tmp" : tmpdir();
const dir = mkdtempSync(join(base, "wpt-"));
const swept = join(dir, ".swept");
const env = { ...process.env, TMPDIR: dir, TEMP: dir, TMP: dir, WP_TMP_SWEPT: swept };

/** `waterplane-ctxlog-AbC123` -> `waterplane-ctxlog-` */
const prefixOf = (n) => n.replace(/[A-Za-z0-9]{6}$/, "").replace(/-?$/, "-");
function tally(names) {
  const m = new Map();
  for (const n of names) m.set(prefixOf(n), (m.get(prefixOf(n)) || 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).map(([p, c]) => `${p}* x${c}`).join(", ");
}

const child = spawn(cmd[0], cmd.slice(1), { env, stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));

child.on("error", (e) => { console.error(`[with-tmp] cannot run ${cmd[0]}: ${e.message}`); finish(127); });
child.on("close", (code, sig) => finish(code ?? (sig ? 1 : 0)));

function finish(code) {
  let sweptNames = [];
  try { sweptNames = readFileSync(swept, "utf8").split("\n").filter(Boolean); } catch { /* none */ }
  let left = [];
  try { left = readdirSync(dir).filter((n) => n !== ".swept" && !n.startsWith("tsx-")); } catch { /* gone */ }
  if (sweptNames.length) console.warn(`[with-tmp] WARNING: ${sweptNames.length} temp dir(s) were not removed by their test (swept by the preload): ${tally(sweptNames)}`);
  if (left.length) console.warn(`[with-tmp] WARNING: ${left.length} entr${left.length === 1 ? "y" : "ies"} left in the run's temp dir: ${tally(left)}`);
  if (code !== 0 && process.env[E.KEEP_TEST_TMP] === "1") {
    console.warn(`[with-tmp] run failed; keeping ${dir}`);
  } else {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  process.exit(code);
}
