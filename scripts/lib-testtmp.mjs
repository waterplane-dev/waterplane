// Preload for the node --test suites (`node --import ./scripts/lib-testtmp.mjs --test …`).
//
// A test file that mkdtemp's under the temp dir and never removes it leaks
// for ever (250 x 100 MB once filled a disk). Every file runs in its own
// process, so this records what THAT process mkdtemp'd under the temp dir and
// removes whatever is still there when it exits. A test that cleans up after
// itself never shows up here; one that does not is removed anyway AND named in
// the file `WP_TMP_SWEPT` points at, which `with-tmp.mjs` turns into a warning.
import fs, { appendFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";

const made = new Set();
let root = "";
try { root = realpathSync(tmpdir()); } catch { /* no temp dir: record nothing */ }

function note(p) {
  try {
    const real = realpathSync(p);
    if (root && dirname(real) === root) made.add(real);
  } catch { /* gone already */ }
  return p;
}

const { mkdtempSync, mkdtemp } = fs;
const pmk = fs.promises.mkdtemp;
fs.mkdtempSync = (...a) => note(mkdtempSync(...a));
fs.mkdtemp = (...a) => {
  const cb = a[a.length - 1];
  if (typeof cb !== "function") return mkdtemp(...a);
  return mkdtemp(...a.slice(0, -1), (err, p) => { if (!err) note(p); cb(err, p); });
};
fs.promises.mkdtemp = async (...a) => note(await pmk(...a));
syncBuiltinESMExports();

process.on("exit", () => {
  const swept = [];
  for (const d of made) {
    if (!existsSync(d)) continue;
    swept.push(basename(d));
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (swept.length && process.env.WP_TMP_SWEPT) {
    try { appendFileSync(process.env.WP_TMP_SWEPT, swept.join("\n") + "\n"); } catch { /* best effort */ }
  }
});
