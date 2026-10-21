/**
 * The shared package's SHAPE: `src/intent.ts` only shrinks, and the folder it
 * is cut into (`src/intent/`) stays a set of slices that cannot regrow into the
 * file they came out of.
 *
 * `hostshape.test.mjs`'s argument, one package over. `intent.ts` was the
 * repo's longest file (2,860 lines): the model, the ladder, the sentences, the
 * row cleaner and the classifiers in one place, so every change to deferred
 * work conflicted in it. The split pays only while it is one-way, so:
 *
 *   • the barrel's line count is a RATCHET — lower it in the commit that moves
 *     code out, never raise it to pass;
 *   • every slice is capped (`MAX_SLICE_LINES`);
 *   • a move is a MOVE: no name is defined both in the barrel and in a slice,
 *     or in two slices (two copies of a rung are two opinions about a row);
 *   • the slices import each other directly and NEVER the barrel — the barrel
 *     re-exports them, so a slice importing it is a cycle — and nothing outside
 *     `intent/` names a slice: `./intent.js` is the one door, which is what lets
 *     a later cut move a name between slices without touching an importer.
 *
 * The exported SURFACE is pinned separately, through the type checker, in
 * `packages/shared/test/intentsurface.test.mjs`. All of this is read as TEXT:
 * no build, no import. Reasoning: docs/notes/shared-architecture.md.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "packages", "shared", "src");

/** Lower it when code moves out, in the same commit. The end state is a
 *  barrel: the module's header and its re-exports, nothing defined. */
const MAX_BARREL_LINES = 90; // 89 → 90 (2026-10-16): the slot check's one export line (`intent/slot.ts`)

/** Every `src/intent/*.ts`. The ESLint `max-lines` warning is 900; a slice
 *  here is held to 600 because the largest region of the old file (the
 *  ladder) fits in it, and a slice past it is two responsibilities. */
const MAX_SLICE_LINES = 600;

const lines = (text) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
const read = (rel) => readFileSync(join(SRC, rel), "utf8");
/** Code, not prose. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const slices = () => {
  const d = join(SRC, "intent");
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".ts")).sort().map((f) => `intent/${f}`);
};

/** Top-level definitions: declarations at column 0. */
const DEF = /^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/;
const defsIn = (text) => {
  const out = new Set();
  for (const l of code(text).split("\n")) {
    const m = DEF.exec(l);
    if (m) out.add(m[1]);
  }
  return out;
};

test("intent.ts does not grow", () => {
  const n = lines(read("intent.ts"));
  if (n < MAX_BARREL_LINES - 50) console.log(`# intent.ts is ${n} lines — lower MAX_BARREL_LINES in tools/sharedshape.test.mjs to lock that in`);
  assert.ok(
    n <= MAX_BARREL_LINES,
    `intent.ts is ${n} lines, over its ${MAX_BARREL_LINES} ratchet. New intent logic belongs in a slice under ` +
    `packages/shared/src/intent/ — see docs/notes/shared-architecture.md. Raise the number only as a decision.`,
  );
});

test(`no intent/ slice is over ${MAX_SLICE_LINES} lines`, () => {
  const over = slices().map((f) => [f, lines(read(f))]).filter(([, n]) => n > MAX_SLICE_LINES);
  assert.deepEqual(over.map(([f, n]) => `${f}: ${n} lines`), [], `A slice past ${MAX_SLICE_LINES} lines is two responsibilities — cut it again.`);
});

test("a move is a move: no name defined twice across intent.ts and its slices", () => {
  const where = new Map();
  for (const f of ["intent.ts", ...slices()]) {
    for (const name of defsIn(read(f))) where.set(name, [...(where.get(name) ?? []), f]);
  }
  const dup = [...where].filter(([, fs]) => fs.length > 1).map(([n, fs]) => `${n}: ${fs.join(" AND ")}`);
  assert.deepEqual(dup, [], `A copy-then-delete move left the original behind — delete one.`);
});

test("once the slices exist, intent.ts is a barrel: it defines nothing", () => {
  if (slices().length === 0) return; // not split yet
  const defs = [...defsIn(read("intent.ts"))];
  assert.deepEqual(defs, [], `intent.ts re-exports its slices (\`export { x } from "./intent/verdict.js"\`) and defines nothing.`);
});

test("slices never import the barrel, and only the barrel imports a slice", () => {
  const bad = [];
  for (const f of slices()) {
    if (/from\s+"\.\.\/intent\.js"/.test(code(read(f)))) bad.push(`${f} imports ../intent.js (the barrel re-exports it: a cycle)`);
  }
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "intent" && dir === SRC ? [] : walk(p);
    return e.name.endsWith(".ts") ? [p] : [];
  });
  for (const p of walk(SRC)) {
    const rel = relative(SRC, p);
    if (rel === "intent.ts") continue;
    if (/from\s+"(?:\.\.?\/)+intent\/[^"]+"/.test(code(readFileSync(p, "utf8")))) bad.push(`${rel} imports a slice of intent/ — import "./intent.js" instead`);
  }
  assert.deepEqual(bad, [], `./intent.js is the one door into the intent model.`);
});

// ── wire/session.ts, wire/messages.ts and the four logic modules: barrels over folders of slices ──
// The same argument as intent.ts. `session.ts` (1,726 lines) held every DTO that describes a
// session; `messages.ts` (1,363) held both unions. Each is now a barrel (the one door) over a
// folder of slices; `ClientMessage`/`HostMessage` are unions of the slices' member lists, and the
// members are pinned by `packages/shared/test/wiresurface.test.mjs`.
const WIRE_BARRELS = [
  { barrel: "wire/session.ts", dir: "wire/session", maxBarrel: 19 },
  { barrel: "wire/messages.ts", dir: "wire/messages", maxBarrel: 53 },
  // The logic modules cut the same way (sessioncost 1,220 → 122, schedule 1,199 → 102, queue
  // 1,103 → 104, clihealth 940 → 123): header + explicit re-exports, a slice per subject.
  { barrel: "sessioncost.ts", dir: "sessioncost", maxBarrel: 124 },
  { barrel: "schedule.ts", dir: "schedule", maxBarrel: 102 },
  { barrel: "queue.ts", dir: "queue", maxBarrel: 104 },
  { barrel: "clihealth.ts", dir: "clihealth", maxBarrel: 123 },
];
const MAX_WIRE_SLICE_LINES = 500;
const wireSlices = (dir) => {
  const d = join(SRC, dir);
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".ts")).sort().map((f) => `${dir}/${f}`) : [];
};

for (const { barrel, dir, maxBarrel } of WIRE_BARRELS) {
  test(`${barrel} does not grow`, () => {
    const n = lines(read(barrel));
    assert.ok(n <= maxBarrel, `${barrel} is ${n} lines, over its ${maxBarrel} ratchet. New wire types belong in a slice under ${dir}/.`);
  });

  test(`no ${dir}/ slice is over ${MAX_WIRE_SLICE_LINES} lines`, () => {
    const over = wireSlices(dir).map((f) => [f, lines(read(f))]).filter(([, n]) => n > MAX_WIRE_SLICE_LINES);
    assert.deepEqual(over.map(([f, n]) => `${f}: ${n} lines`), [], `A slice past ${MAX_WIRE_SLICE_LINES} lines is two subjects — cut it again.`);
  });

  test(`no name is defined twice across ${barrel} and its slices`, () => {
    const where = new Map();
    for (const f of wireSlices(dir)) for (const name of defsIn(read(f))) where.set(name, [...(where.get(name) ?? []), f]);
    const dup = [...where].filter(([, fs]) => fs.length > 1).map(([n, fs]) => `${n}: ${fs.join(" AND ")}`);
    assert.deepEqual(dup, []);
  });

  test(`slices of ${dir}/ never import their barrel, and only the barrel imports a slice`, () => {
    const bad = [];
    const name = barrel.split("/").pop();
    for (const f of wireSlices(dir)) {
      if (new RegExp(`from\\s+"\\.\\./${name.replace(".", "\\.")}"`).test(code(read(f)))) bad.push(`${f} imports ../${name}`);
    }
    const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = join(d, e.name);
      if (e.isDirectory()) return walk(p);
      return e.name.endsWith(".ts") ? [p] : [];
    });
    const re = new RegExp(`from\\s+"(?:\\.\\.?/)+(?:wire/)?${dir.split("/").pop()}/[^"]+"`);
    for (const p of walk(SRC)) {
      const rel = relative(SRC, p);
      if (rel === barrel || rel.startsWith(`${dir}/`)) continue;
      if (re.test(code(readFileSync(p, "utf8")))) bad.push(`${rel} imports a slice of ${dir}/ — import the barrel instead`);
    }
    assert.deepEqual(bad, []);
  });
}
