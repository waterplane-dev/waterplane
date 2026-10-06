/**
 * Pins for splitting the assessment (docs/notes/assess-architecture.md).
 *
 * `assessRows.ts` (pure rules) and `AssessSheet.tsx` (the sheet) were two files of
 * ~1700 and ~1600 lines. Both stay importable and are now a barrel / facade over
 * `assess/` (`arows*.ts` slices, `useAssessSheet.ts` + `Asx*.tsx` regions). A
 * copy-then-delete move can DUPLICATE a hook, a confirm or a tracked tap, or DROP
 * an export an importer needs. So:
 *
 *  - P1: both files export exactly the names they did, read off the type checker.
 *  - P2: the sheet's side-effect sites are counted as TEXT over the facade +
 *    `assess/Asx*`/`useAssessSheet`, file-agnostic: the same counts hold before and after.
 *  - P3: its never-do list (nothing applies itself: one `onApply` call, one tap
 *    behind it; no native modal, no textarea, no socket).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "packages", "web", "src");

const ROWS_SURFACE = [
  "ASSESS_MISSING_BLOCKED:value", "ASSESS_NOTE_OFFERED:value", "ASSESS_QUIET_MS:value",
  "ASSESS_SAMPLE:value", "AssessAcceptWords:type", "AssessAnswers:type", "AssessApplySummary:type",
  "AssessBulkWords:type", "AssessDisplayRow:type", "AssessFiled:type", "AssessGroup:type",
  "AssessGuide:type", "AssessMergeCard:type", "AssessReadyRow:type", "AssessRowHead:type",
  "AssessStepCounts:type", "AssessWatch:type", "LEAVE_WORDS:value", "NEW_ITEM_WORDS:value",
  "NOTE_ITEM_WORDS:value", "assessAcceptBlocker:value", "assessAcceptWords:value",
  "assessAppliedWords:value", "assessApplyBlocker:value", "assessApplyLabel:value", "assessApplyNote:value",
  "assessApplySummary:value", "assessBulkLines:value", "assessBulkWords:value", "assessCutLabel:value",
  "assessDowngradeTally:value", "assessElapsed:value", "assessFiledSplit:value", "assessFiledWords:value",
  "assessGroups:value", "assessGuide:value", "assessMergeLines:value", "assessMissingWords:value",
  "assessNewItemNote:value", "assessNoteItemNote:value", "assessNotesFiledWords:value",
  "assessOpenBacklogLabel:value", "assessOpenBacklogNote:value", "assessPickedCount:value",
  "assessPickedLabel:value", "assessReadyCut:value", "assessRetires:value", "assessRowHead:value",
  "assessRowPosition:value", "assessRunBlocker:value", "assessStepCounts:value", "assessStepVerb:value",
  "assessWatch:value", "requeueWhereWords:value",
];
const SHEET_SURFACE = ["AssessSheet:value", "AssessSheetProps:type"];

function surfaceOf(rel) {
  const file = join(SRC, rel);
  const program = ts.createProgram([file], {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const mod = checker.getSymbolAtLocation(program.getSourceFile(file));
  assert.ok(mod, `${rel} did not parse as a module`);
  return checker.getExportsOfModule(mod).map((s) => {
    const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
    return `${s.name}:${target.flags & ts.SymbolFlags.Value ? "value" : "type"}`;
  }).sort();
}

test("P1: assessRows.ts exports exactly its pinned surface, values and types alike", () => {
  assert.deepEqual(surfaceOf("assessRows.ts"), [...ROWS_SURFACE].sort());
});

test("P1: AssessSheet.tsx exports exactly its pinned surface", () => {
  assert.deepEqual(surfaceOf("AssessSheet.tsx"), [...SHEET_SURFACE].sort());
});

/** `AssessSheet.tsx` plus the sheet's own files under `assess/` (not the `arows*` rules), comments stripped. */
function sheet() {
  const parts = [readFileSync(join(SRC, "AssessSheet.tsx"), "utf8")];
  const dir = join(SRC, "assess");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir, { recursive: true }).filter((f) => /^(asx|useAssess).*\.(ts|tsx)$/i.test(f)).sort()) {
      parts.push(readFileSync(join(dir, f), "utf8"));
    }
  }
  return parts.join("\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const count = (re) => [...sheet().matchAll(re)].length;

test("P2: the sheet's side-effect sites are counted once", () => {
  assert.equal(count(/\bsavePicks\(/g), 1, "the one write-back effect");
  assert.equal(count(/\bdropPicks\(/g), 2, "a retired run's picks, and the apply");
  assert.equal(count(/\bloadPicks\(/g), 6, "rows, merges, news, rejected, and the pin and naming answers");
  assert.equal(count(/\buseEffect\(/g), 2);
  assert.equal(count(/\baskConfirm\(/g), 2, "the bulk strip confirm and the merge confirm");
  assert.equal(count(/\bp\.onApply\(/g), 1, "the one place an apply is sent");
  assert.equal(count(/\bp\.onRun\(/g), 1);
  assert.equal(count(/\btrack\(/g), 21);
  assert.equal(count(/\bopenSettingsAt\(/g), 1);
  assert.equal(count(/^export function AssessSheet\(/gm), 1);
});

test("P3: nothing applies itself, and the sheet's never-do list", () => {
  const all = sheet();
  assert.doesNotMatch(all, /window\.confirm|\bconfirm\(/, "no native modal");
  assert.equal(count(/<textarea/g), 0);
  assert.equal(count(/new WebSocket|sendWs\(|ws\.send\(/g), 0, "no send path of its own");
  assert.equal(count(/\bonApply\b/g), 2, "the prop's type and the one call");
});
