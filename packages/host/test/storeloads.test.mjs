/**
 * The load-then-save stores keep a file they could not read (lost-read audit B, tools/storereads.test.mjs).
 *
 * Each store below loads a JSON file with a cleaner that turns anything into defaults, then saves over
 * the same name. A corrupt file, or one of the wrong shape, used to be erased by that save. Now the load goes
 * through `readJsonGuarded` (jsonstore.ts), which moves it to `<name>.corrupt-<ts>` first. The test writes
 * the bad bytes, loads, saves through the module's own save, and finds the original bytes in a kept-aside file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { hostStateDir, repoStateDir } from "../dist/branddirs.js";
import { writeJsonAtomic } from "../dist/jsonstore.js";
import { artifactPolicy, saveArtifactPolicy } from "../dist/artifacts.js";
import { AutoPullManager } from "../dist/autopull.js";
import { CaptureManager } from "../dist/capture.js";
import { readScopes, writeScopes } from "../dist/repohealthscopes.js";
import { loadSummary } from "../dist/sessions/record.js";

const CORRUPT = "{ this is not json";
const WRONG_SHAPE = "[1,2,3]";

/** Every file beside `path` kept under a `.corrupt-` name, as their contents. */
function kept(path) {
  const base = path.slice(dirname(path).length + 1) + ".corrupt-";
  return readdirSync(dirname(path)).filter((f) => f.startsWith(base)).map((f) => readFileSync(join(dirname(path), f), "utf8"));
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "storeloads-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** `bytes` at `path`, then `load()` then `save()`: the bytes must still be somewhere. */
function check(path, bytes, load, save) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  load();
  save();
  assert.deepEqual(kept(path), [bytes], `${path}: the original bytes are kept aside`);
}

for (const [label, bytes] of [["corrupt", CORRUPT], ["wrong-shape", WRONG_SHAPE]]) {
  test(`artifacts.json (${label}) is kept aside before the policy is saved`, () => {
    const r = repo();
    check(join(repoStateDir(r), "artifacts.json"), bytes, () => artifactPolicy(r), () => saveArtifactPolicy(r, { collect: true, prune: true, keep: 5 }));
  });

  test(`autopull.json (${label}) is kept aside before the rule is saved`, () => {
    const r = repo();
    const m = new AutoPullManager(repo());
    check(join(repoStateDir(r), "autopull.json"), bytes, () => m.config(r), () => m.saveConfig(r, m.config(r)));
  });

  test(`capture.json (${label}) is kept aside before the targets are saved`, () => {
    const r = repo();
    const m = new CaptureManager(null);
    // an array is a valid legacy shape for the targets file, so its wrong shape is a number
    check(join(repoStateDir(r), "capture.json"), label === "wrong-shape" ? "42" : bytes, () => m.list(r), () => m.save(r, []));
  });

  test(`repohealth-scopes.json (${label}) is kept aside before the scopes are saved`, () => {
    const r = repo();
    // an array is a valid legacy shape for the scopes file, so its wrong shape is a number
    const b = label === "wrong-shape" ? "42" : bytes;
    check(join(repoStateDir(r), "repohealth-scopes.json"), b, () => readScopes(r), () => writeScopes(r, []));
  });

  test(`the session summary (${label}) is kept aside before the tab name is saved`, () => {
    const root = repo();
    const core = { root };
    const path = join(hostStateDir(root), "summaries", "s1.json");
    // saveSummary is private to the module: it is this same atomic write to the same name
    check(path, bytes, () => loadSummary(core, "s1"), () => writeJsonAtomic(path, { tab: "x" }));
  });
}
