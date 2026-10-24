/** A committed in-repo link to a dotenv file must not show the dotenv file. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTextFile, secretAt } from "../dist/git.js";
import { readTreeFile, writeTreeFile } from "../dist/tree.js";
import { readInTree } from "../dist/files.js";

test("a link docs/x.txt -> ../.env shows nothing; a normal file still reads", async (t) => {
  const wt = realpathSync(mkdtempSync(join(tmpdir(), "wp-secretfile-")));
  t.after(() => rmSync(wt, { recursive: true, force: true }));
  mkdirSync(join(wt, "docs"));
  writeFileSync(join(wt, ".env"), "TOKEN=hunter2\n");
  writeFileSync(join(wt, "docs", "ok.txt"), "hello");
  symlinkSync("../.env", join(wt, "docs", "x.txt"));
  assert.equal(await readTextFile(wt, "docs/x.txt"), null);
  assert.equal(readTreeFile(wt, "docs/x.txt"), null);
  assert.equal(readInTree(wt, "docs/x.txt", { anyType: true }), null);
  assert.equal(writeTreeFile(wt, "docs/x.txt", "x", "deadbeef").ok, false);
  assert.equal(secretAt(wt, "docs/x.txt", join(wt, "docs", "x.txt")), true);
  assert.equal(await readTextFile(wt, "docs/ok.txt"), "hello");
  assert.ok(readTreeFile(wt, "docs/ok.txt"));
  assert.ok(readInTree(wt, "docs/ok.txt", { anyType: true }));
});
