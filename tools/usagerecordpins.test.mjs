/**
 * The claude CLI's per-reply usage record has ONE reader in the host:
 * `packages/host/src/ctxlog/usagerecord.ts`.
 *
 * Five readers once spelled its rules by hand (skip `<synthetic>`, dedupe by
 * `message.id`, anchor on the first request that carried context), each citing
 * another by comment, and a fix landed in one copy: c3190495 taught
 * `tokenscan.ts` the anchor while `backends/overhead.ts` kept the old bug. This
 * is the RATCHET that keeps a sixth copy from starting: the record's field name
 * is spelled in code nowhere else. Read as text: no build, no import.
 *
 * The one exception is named, not counted away: `sidecar/sidecarclaude.ts`
 * reads `claude -p --output-format json`'s envelope, a different shape that
 * happens to share the field names.
 *
 * Read through the TypeScript PARSER, not a regex: the field is looked for in
 * identifiers and string literals only, so a comment naming it is free and a
 * `/*` inside a string (seven files here have one) cannot hide the code after it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const SRC = join(new URL("..", import.meta.url).pathname, "packages", "host", "src");
const FIELD = "cache_read_input_tokens";

/** Whether the file's CODE names the field: an identifier or a string/template part, never a comment. */
function codeNames(path) {
  const src = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  let hit = false;
  const visit = (n) => {
    if (hit) return;
    if ((ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) && n.text === FIELD) { hit = true; return; }
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n)
      || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && n.text.includes(FIELD)) { hit = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return hit;
}
const OWNER = "ctxlog/usagerecord.ts";
const EXEMPT = new Set(["sidecar/sidecarclaude.ts"]);

function* tsFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* tsFiles(p);
    else if (e.name.endsWith(".ts")) yield p;
  }
}

test("cache_read_input_tokens is read only by ctxlog/usagerecord.ts (sidecarclaude.ts excepted)", () => {
  const spellers = [];
  for (const p of tsFiles(SRC)) {
    const rel = relative(SRC, p);
    if (codeNames(p)) spellers.push(rel);
  }
  assert.ok(spellers.includes(OWNER), `${OWNER} reads the record`);
  assert.deepEqual(spellers.filter((r) => r !== OWNER && !EXEMPT.has(r)), [],
    "A usage record is read through usageRecordOf (ctxlog/usagerecord.ts), never by hand: a second copy is where a fix lands once.");
});
