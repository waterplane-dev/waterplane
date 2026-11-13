/**
 * "The base this branch is measured against" has ONE owner: packages/host/src/landedbase.ts.
 * A `["main", "master"]` list (either order, any quoting) anywhere else in the host is a fresh
 * guess at it — the guess git.ts made twice, which left a develop/trunk repo with no base and
 * closing a session with unlanded commits silent. Ask landedBase() instead. (prpush.ts asks the
 * forge for the push rule and has no such list.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(new URL("..", import.meta.url).pathname, "packages", "host", "src");
const Q = `["'\`]`;
const GUESS = new RegExp(`\\[\\s*${Q}(?:main${Q}\\s*,\\s*${Q}master|master${Q}\\s*,\\s*${Q}main)${Q}`);
const OWNER = "landedbase.ts";

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.tsx?$/.test(e.name)) yield p;
  }
}

test("no main/master guess outside landedbase.ts", () => {
  const bad = [];
  for (const f of walk(SRC)) {
    const rel = relative(SRC, f);
    if (rel === OWNER) continue;
    if (GUESS.test(readFileSync(f, "utf8"))) bad.push(rel);
  }
  assert.deepEqual(bad, [], `these files guess the base branch — call landedBase() (landedbase.ts):\n${bad.join("\n")}`);
});

test("the pattern catches either order and any quote", () => {
  for (const s of [`["main", "master"]`, `['master','main']`, "[`main`, `master`]", `[ "main" ,"master" ]`]) assert.match(s, GUESS);
  assert.doesNotMatch(`["main", "develop"]`, GUESS);
});

test("landedbase.ts holds the order", () => {
  assert.match(readFileSync(join(SRC, OWNER), "utf8"), /\["main", "master"\]/);
});
