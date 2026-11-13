/**
 * "What a session means to the send lane" has ONE owner: packages/shared/src/queue/queuelanestate.ts
 * (`laneStateOf`). A `LaneSessionState` literal built by hand anywhere else — the phone's mapping
 * and the host's `intentDeps` literal were two copies — is a fresh chance to forget a field, and an
 * absent field reads as FREE: a prompt typed into a question box. Call laneStateOf() and spread
 * the host/phone-only facts on top.
 *
 * The tell is `promptKind:` / `limitBlocked:` written as an object key in a package's source:
 * those fields exist only on LaneSessionState (SessionInfo says `prompt` and `limit`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OWNER = "packages/shared/src/queue/";
const KEY = /\b(?:promptKind|limitBlocked)\s*:/;

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) yield p;
  }
}
const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("no LaneSessionState literal outside shared/src/queue", () => {
  const bad = [];
  for (const dir of ["shared", "host", "web", "app", "vscode"].map((d) => join(ROOT, "packages", d))) {
    let files = [];
    try { files = [...walk(dir)]; } catch { continue; }
    for (const f of files) {
      const rel = relative(ROOT, f);
      if (rel.startsWith(OWNER)) continue;
      if (KEY.test(code(readFileSync(f, "utf8")))) bad.push(rel);
    }
  }
  assert.deepEqual(bad, [], `build lane facts with laneStateOf() (shared/queue/queuelanestate.ts):\n${bad.join("\n")}`);
});

test("the pattern catches a hand-built literal", () => {
  assert.match(`{ limitBlocked: s.limit?.blocked }`, KEY);
  assert.match(`x = { promptKind : s.prompt?.kind }`, KEY);
  assert.doesNotMatch(`s.promptKind`, KEY);
});
