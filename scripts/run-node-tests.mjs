// `node --test` over the given globs, with run-e2e.mjs's rule for a failure only load produced.
//
//   node scripts/run-node-tests.mjs "<glob>" ["<glob>" …]
//
// The suite runs as before (the tmp preload, the two-minute per-test timeout, every file in its
// own process). When it fails, each FILE that failed runs once more, ALONE: one that fails alone
// too is a break and fails the run; one that passes alone failed only beside its siblings — a
// wall-clock window in the test or the code that a loaded machine stretched. That kind no longer
// refuses a push (run-e2e.mjs, owner's call 2026-10-20), and it is never silent either: the
// summary names it as a LOAD FLAKE with its failing tests, and it is appended to
// `~/.cache/<slug>/host-flakes.jsonl` so it gets fixed (2026-10-20 raised seven test:host
// deadlines by hand after the same kind of refusal; 2026-10-27 ocsessionid refused a push again).
// Past RETRY_MAX failed files at once is a break, not load, and is not re-run.
// `TEST_RETRY_ALONE=0` turns the re-run off.
//
// Which files failed is read off the runner's own events (a second reporter, `lib-failfiles.mjs`),
// never off the spec text. A failed `todo` is not a failure. A failure no file is named for (the
// runner itself) is a break.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SLUG } from "./lib-brand.mjs";

const globs = process.argv.slice(2);
if (!globs.length) { console.error("usage: run-node-tests.mjs <glob> [<glob> …]"); process.exit(2); }

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const RETRY_MAX = 5;
const FLAKES_FILE = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), SLUG, "host-flakes.jsonl");
const scratch = mkdtempSync(join(tmpdir(), "failfiles-"));

/** One `node --test` run; resolves with its exit code and the failures the reporter recorded. */
function run(files, { echo }, n) {
  const failOut = join(scratch, `fail-${n}.jsonl`);
  const args = [
    "--import", "./scripts/lib-testtmp.mjs", "--test", "--test-timeout=120000",
    "--test-reporter=spec", "--test-reporter-destination=stdout",
    `--test-reporter=${join(HERE, "lib-failfiles.mjs")}`, `--test-reporter-destination=${failOut}`,
    ...files,
  ];
  return new Promise((resolve) => {
    const out = [];
    const child = spawn(process.execPath, args, { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    const take = (stream) => (d) => { out.push(d); if (echo) stream.write(d); };
    child.stdout.on("data", take(process.stdout));
    child.stderr.on("data", take(process.stderr));
    child.on("close", (code, signal) => {
      let fails = [];
      try {
        fails = readFileSync(failOut, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      } catch { /* no failures written, or the run died before the reporter could */ }
      resolve({ code: code ?? (signal ? 1 : 0), fails, text: Buffer.concat(out).toString("utf8") });
    });
  });
}

const rel = (f) => { const r = relative(REPO, f); return r && !r.startsWith("..") ? r : f; };
const first = await run(globs, { echo: true }, 0);
if (first.code === 0) { rmSync(scratch, { recursive: true, force: true }); process.exit(0); }

const files = [...new Set(first.fails.map((f) => f.file))];
const unnamed = first.fails.some((f) => !f.file) || !first.fails.length;
const retrying = process.env.TEST_RETRY_ALONE !== "0" && !unnamed && files.length <= RETRY_MAX;
const flaky = [], broken = [];
if (retrying) {
  let n = 1;
  for (const file of files) {
    console.log(`\n[run-node-tests] ${rel(file)} failed beside other files — running it once more alone, to tell a load flake from a break`);
    const alone = await run([file], { echo: false }, n++);
    if (alone.code === 0) { flaky.push(file); console.log(`[run-node-tests] ${rel(file)} passed alone — a load flake, not blocking`); continue; }
    broken.push(file);
    process.stdout.write(`\n──────── ${rel(file)} (alone) ────────\n${alone.text}\n[run-node-tests] ${rel(file)} FAILED alone too\n`);
  }
}
rmSync(scratch, { recursive: true, force: true });

// The summary is the LAST lines on purpose: a push refused from the phone shows only the tail.
const names = (file) => first.fails.filter((f) => f.file === file).map((f) => f.name).slice(0, 4);
console.log("");
if (!retrying) {
  const why = unnamed ? "a failure no test file is named for" : process.env.TEST_RETRY_ALONE === "0"
    ? "TEST_RETRY_ALONE=0" : `${files.length} files failed at once — that many is a break, not load`;
  console.error(`[run-node-tests] FAILED (exit ${first.code}); not re-run alone: ${why}`);
  for (const file of files) console.error(`  FAILED  ${rel(file)}: ${names(file).join(" · ")}`);
  process.exit(first.code || 1);
}
for (const file of files) {
  const flake = flaky.includes(file);
  console.error(`  ${flake ? "LOAD FLAKE" : "FAILED"}  ${rel(file)}${flake ? " — passes alone: a timing window load stretched; not blocking, logged to " + FLAKES_FILE : " — fails alone too"}`);
  for (const name of names(file)) console.error(`      ✖ ${name}`);
}
if (flaky.length) {
  try {
    mkdirSync(dirname(FLAKES_FILE), { recursive: true });
    const at = new Date().toISOString();
    appendFileSync(FLAKES_FILE, flaky.map((file) => JSON.stringify({ at, file: rel(file), tests: names(file) }) + "\n").join(""));
  } catch (e) { console.error(`  (could not log the flakes to ${FLAKES_FILE}: ${e.message})`); }
}
process.exit(broken.length ? 1 : 0);
