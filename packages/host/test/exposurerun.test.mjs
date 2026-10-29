/**
 * The exposure watch's re-check from the phone (`exposurerun.ts` + `exposurewatch.ts`'s
 * `exposureTargetOf`): which target this worktree is (by realpath), which runner runs it, what each
 * collector exit says, and that a run actually happens — with a stand-in collector, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { setExposureDir } = await import("../dist/exposure.js");
const { exposureTargetOf } = await import("../dist/exposurewatch.js");
const { exposureRunnerArgv, exposureRunSentence, runExposureWatch } = await import("../dist/exposurerun.js");

function world(targets) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "exporun-")));
  const wt = join(base, "repo");
  const dir = join(base, "exposure");
  mkdirSync(wt);
  mkdirSync(dir);
  setExposureDir(dir);
  if (targets) writeFileSync(join(dir, "targets.json"), JSON.stringify({ version: 1, targets: targets(wt) }));
  return { base, wt, dir };
}

test("exposureTargetOf: matched by realpath, not listed is a sentence pointing at the opt-ins", () => {
  const { base, wt } = world((wt) => [{ name: "mine", dir: wt, play: true }]);
  const link = join(base, "link");
  symlinkSync(wt, link);
  assert.deepEqual(exposureTargetOf(link), { ok: true, name: "mine", play: true });
  const other = world(() => []);
  const r = exposureTargetOf(other.wt);
  assert.equal(r.ok, false);
  assert.match(r.why, /not on the exposure watch.*Opt-ins/);
  const none = world(null);
  assert.equal(exposureTargetOf(none.wt).ok, false);
});

test("exposureRunnerArgv: the knob is argv as said; else this checkout's collector; neither is a refusal", () => {
  assert.deepEqual(exposureRunnerArgv("n", true, "  /bin/run  a b ", "/r", () => false), { argv: ["/bin/run", "a", "b", "--target", "n"] });
  const d = exposureRunnerArgv("n", false, undefined, "/r", () => true);
  assert.deepEqual(d.argv.slice(1), ["/r/tools/exposure.mjs", "run", "--target", "n"]);
  const p = exposureRunnerArgv("n", true, "", "/r", () => true);
  assert.equal(p.argv[p.argv.indexOf("--play-key-missing") + 1].includes("Play key"), true);
  const no = exposureRunnerArgv("n", false, undefined, "/r", () => false);
  assert.match(no.refused, /No exposure collector on this desktop.*WATERPLANE_EXPOSURE_RUNNER/);
});

test("exposureRunSentence: one sentence per collector exit, a stop past the cap says so", () => {
  assert.match(exposureRunSentence(0, "", { secs: 8 }), /nothing new.*/);
  assert.match(exposureRunSentence(0, "", { secs: 8 }), /\(8 s\)/);
  assert.match(exposureRunSentence(10, ""), /needs you/);
  assert.match(exposureRunSentence(2, "x\nnpm: unreachable\n"), /unknown, not clean: npm: unreachable$/);
  assert.match(exposureRunSentence(64, "target x uses {SITE}"), /refused to run: target x uses \{SITE\}/);
  assert.match(exposureRunSentence(1, ""), /exit 1/);
  assert.match(exposureRunSentence(null, "", { timedOut: true }), /stopped after 5 minutes/);
});

test("runExposureWatch: runs the knob's runner with --target, joins a second tap, refuses an unlisted repo", async () => {
  const { base, wt } = world((wt) => [{ name: "mine", dir: wt }]);
  const script = join(base, "fake.mjs");
  writeFileSync(script, "const i = process.argv.indexOf('--target'); setTimeout(() => { process.stderr.write(`ran ${process.argv[i + 1]}\\n`); process.exit(10); }, 150);\n");
  process.env.WATERPLANE_EXPOSURE_RUNNER = `${process.execPath} ${script}`;
  try {
    const [a, b] = await Promise.all([runExposureWatch(wt, "/nowhere"), runExposureWatch(wt, "/nowhere")]);
    assert.equal(a.ok, true);
    assert.equal(a.exit, 10);
    assert.match(a.sentence, /needs you/);
    assert.equal(b.joined, true);
    assert.equal(b.exit, 10);
    const other = world(() => []);
    const r = await runExposureWatch(other.wt, "/nowhere");
    assert.equal(r.refused, true);
    assert.equal(r.ok, false);
  } finally {
    delete process.env.WATERPLANE_EXPOSURE_RUNNER;
    setExposureDir(null);
  }
});
