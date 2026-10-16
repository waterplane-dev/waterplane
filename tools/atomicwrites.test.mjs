/**
 * A ratchet on bare `writeFileSync(` in the host.
 *
 * `writeFileSync` truncates the file first, so a SIGTERM (launchd's `kickstart -k` on every
 * `npm run restart`) or a full disk mid-write leaves HALF a file — and when the file is a repo's
 * own `.gitignore` or `CLAUDE.md`, or a signing-key pointer, that half-file is the user's. Those
 * go through `jsonstore.ts` (`writeTextAtomic`, or `writeTextAtomicKeepMode` for a file that is
 * not ours). This counts what is left, as text, so the number only goes down:
 *
 *  - `compliance.ts`, `secrets.ts` and `signkey.ts` rewrite files in someone's repo and must hold
 *    none — except the one create-exclusive (`flag: "wx"`) of a brand-new shared `builds.json`, which a
 *    rename-over write cannot express (it would replace a file that appeared in the meantime).
 *  - the host as a whole, outside `jsonstore.ts` (the one place that owns the call), may not grow.
 *    LOWER `HOST_MAX` when you convert a site, in the same commit. Raising it is a decision about
 *    the user's files, never a way to pass.
 *
 * The loads that used to be `try { JSON.parse } catch { fresh }` are pinned by
 * `packages/host/test/atomicrewrite.test.mjs`; this file is only the write side.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(new URL("..", import.meta.url).pathname, "packages", "host", "src");

/** Files that rewrite someone else's file: the most bare calls each may hold. */
const REPO_FILES = { "compliance.ts": 1, "secrets.ts": 0, "signkey.ts": 0 };

/** Host-wide, outside jsonstore.ts. Lower it when you convert a site. */
const HOST_MAX = 23;

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") ? [join(dir, e.name)] : []);
}

/** Calls only: a comment that names the function is not one. */
function bareCalls(file) {
  return readFileSync(file, "utf8").split("\n").filter((l) => /\bwriteFileSync\(/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l)).length;
}

test("the files that rewrite a repo's own files hold no truncating write", () => {
  for (const [name, max] of Object.entries(REPO_FILES)) {
    const n = bareCalls(join(SRC, name));
    assert.ok(n <= max, `${name} has ${n} bare writeFileSync( (max ${max}) — use writeTextAtomic / writeTextAtomicKeepMode from jsonstore.ts`);
  }
});

test("bare writeFileSync( in the host only goes down", () => {
  const per = walk(SRC).filter((f) => relative(SRC, f) !== "jsonstore.ts").map((f) => [relative(SRC, f), bareCalls(f)]).filter(([, n]) => n);
  const total = per.reduce((a, [, n]) => a + n, 0);
  assert.ok(total <= HOST_MAX, `${total} bare writeFileSync( outside jsonstore.ts (max ${HOST_MAX}): ${per.map(([f, n]) => `${f}:${n}`).join(", ")}`);
});
