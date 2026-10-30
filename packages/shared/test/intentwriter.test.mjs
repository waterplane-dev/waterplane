// Who may write each field of an Intent — `INTENT_FIELD_WRITER`, the ONE list
// every client entry applies (`clientIntentFields`). A type only one side
// states is not a contract: a decoded frame is whatever the sender put in it.
//
// The list is typed as a Record over every key of `Intent`, so a new field does
// not compile without a line there. These tests hold the same thing from the
// source text, so the classification and the two wire DTOs cannot drift either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { INTENT_FIELD_WRITER, clientIntentFields } from "../dist/index.js";

const src = (rel) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");

/** Top-level field names of `export interface <name> {` in a source file. */
function fieldsOf(file, name) {
  const text = src(file);
  const start = text.indexOf(`export interface ${name} {`);
  assert.ok(start >= 0, `${name} in ${file}`);
  const body = [];
  let depth = 0;
  for (const line of text.slice(start).split("\n").slice(1)) {
    if (depth === 0 && /^}/.test(line)) break;
    const m = depth === 0 ? /^  ([A-Za-z_]\w*)\??:/.exec(line) : null;
    if (m) body.push(m[1]);
    for (const ch of line.replace(/\/\/.*$/, "")) { if (ch === "{" || ch === "(") depth++; else if (ch === "}" || ch === ")") depth--; }
  }
  return body;
}

test("every field of Intent is classified, and nothing else is", () => {
  const intent = fieldsOf("intent/row.ts", "Intent").sort();
  assert.ok(intent.length > 40, "the parse found the interface");
  assert.deepEqual(Object.keys(INTENT_FIELD_WRITER).sort(), intent);
});

test("the `edit` fields are exactly IntentPatch's vocabulary", () => {
  const edit = Object.entries(INTENT_FIELD_WRITER).filter(([, w]) => w === "edit").map(([k]) => k).sort();
  assert.deepEqual(edit, fieldsOf("wire/intent.ts", "IntentPatch").sort());
});

test("every IntentDraft field a client may not post is the host's, and only these three", () => {
  const draft = fieldsOf("wire/intent.ts", "IntentDraft");
  for (const k of draft) assert.ok(k in INTENT_FIELD_WRITER, `${k} is an Intent field`);
  // a new draft field classed `host` is silently dropped by postClientDraft — it must be a decision
  const host = draft.filter((k) => INTENT_FIELD_WRITER[k] === "host").sort();
  assert.deepEqual(host, ["budgetPass", "leftoverOf", "pastBudget"]);
});

test("a patch keeps only `edit` fields; a draft also keeps `post` ones", () => {
  const raw = {
    id: "x", label: "words", trigger: { kind: "idle" }, origin: "o",
    nextAt: null, clearedOccurrence: 5, lastOccurrence: 4, state: "done", requeueCount: 9,
    followed: true, handOrdered: true, blockReason: "budget", bogus: 1,
  };
  assert.deepEqual(clientIntentFields(raw, "edit"), { label: "words", trigger: { kind: "idle" } });
  assert.deepEqual(clientIntentFields(raw, "post"), { id: "x", label: "words", trigger: { kind: "idle" }, origin: "o" });
  assert.ok(!("nextAt" in clientIntentFields(raw, "post")), "nextAt is the host's");
});

test("garbage in is an empty object, never a throw", () => {
  assert.deepEqual(clientIntentFields(null, "edit"), {});
  assert.deepEqual(clientIntentFields("x", "post"), {});
});
