/**
 * The SHAPE of the unattended model spender's files, split into folders:
 * `assess.ts` in `packages/host/src` and in `packages/shared/src` (the smart
 * pick's two were here too until it was removed, 2026-10-16). Each original
 * path is a barrel over `<name>/`.
 *
 * Moves only: the `claude -p` flags, prompts, timeouts and the "nothing applies
 * itself" rule live in the same text as before (the host's spawn seam is
 * `sidecar.ts`, untouched). This test pins what makes a move a MOVE:
 *
 *   - the barrels' exported SURFACE (names, value or type), read off the type
 *     checker, equal to what the files exported before the split;
 *   - barrels only shrink (ratchet) and every slice is capped at 500 lines;
 *   - no name is defined in two files of one module (a copy is two opinions);
 *   - a slice never imports its own barrel (a cycle), and nothing outside the
 *     folder names a slice — the barrel is the one door.
 *
 * Basenames are unique across packages (hostshape): host slices are `hass*`,
 * shared slices `sass*`; web's assess slices are `arows*`.
 * Reasoning: docs/notes/spender-split.md.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = new URL("..", import.meta.url).pathname;

const MODULES = {
  "host/assess": { pkg: "host", name: "assess", barrelMax: 61, surface: ["ASSESSABLE_STATES:value","ASSESS_CONTEXT_MAX:value","ASSESS_MAX_RUNS:value","ASSESS_PROGRESS_MS:value","ASSESS_TAIL_MAX:value","ASSESS_TIMEOUT_MS:value","AssessApplyOutcome:type","AssessDeps:type","AssessIntents:type","AssessRunOutcome:type","AssessStore:value","applyProposal:value","assessProgressInit:value","assessPrompt:value","buildAssessInput:value","foldAssessEvent:value","makeAssessExecutor:value","resultText:value","runAssessment:value","startAssessment:value"] },
  "shared/assess": { pkg: "shared", name: "assess", barrelMax: 59, surface: ["ASSESS_IN_FILE:value","ASSESS_NAME_SKIP:value","ASSESS_NAME_WRITE:value","ASSESS_OUT_FILE:value","ASSESS_PIN_FREE:value","ASSESS_PIN_KEEP:value","ASSESS_PLAN_FILE:value","ASSESS_VERDICTS:value","AssessApplyContext:type","AssessChoices:type","AssessConflict:type","AssessDismiss:type","AssessDowngrade:type","AssessInput:type","AssessItem:type","AssessMerge:type","AssessMutations:type","AssessName:type","AssessNew:type","AssessNote:type","AssessPost:type","AssessProposal:type","AssessRank:type","AssessRow:type","AssessScope:type","AssessSource:type","AssessSplit:type","AssessSplitApply:type","AssessVerdict:type","CITING_VERDICTS:value","MAX_ASSESS_NOTES:value","MAX_CONFLICTS:value","MAX_CONFLICT_IDS:value","MAX_EVIDENCE_CHARS:value","MAX_MERGE_GROUPS:value","MAX_MERGE_SIZE:value","MAX_NEW:value","MAX_PROMPT_CHARS:value","MAX_RANK:value","MAX_RATIONALE_CHARS:value","MAX_SPLITS:value","MIN_MERGE_SIZE:value","SPLIT_PARTS:value","applyAssessment:value","assessConflictSentence:value","assessCounts:value","assessDismissReason:value","assessNameCount:value","assessNameNote:value","assessNameQuestion:value","assessOrigin:value","assessPinNote:value","assessPinQuestion:value","assessRowSentence:value","assessSplitReason:value","assessSplitSentence:value","assessVerdictLabel:value","cleanAssessScope:value","cleanAssessment:value","downgradeText:value"] },
};
const MAX_SLICE_LINES = 500;

const lines = (t) => t.split("\n").length - (t.endsWith("\n") ? 1 : 0);
const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const srcOf = (m) => join(ROOT, "packages", m.pkg, "src");
const sliceFiles = (m) => {
  const d = join(srcOf(m), m.name);
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".ts")).sort() : [];
};
const DEF = /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/;
const defsIn = (t) => code(t).split("\n").map((l) => DEF.exec(l)?.[1]).filter(Boolean);

for (const [key, m] of Object.entries(MODULES)) {
  test(`${key}: the barrel exports exactly its pinned surface, values and types alike`, () => {
    const barrel = join(srcOf(m), `${m.name}.ts`);
    const program = ts.createProgram([barrel], {
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022, noEmit: true, skipLibCheck: true,
    });
    const checker = program.getTypeChecker();
    const mod = checker.getSymbolAtLocation(program.getSourceFile(barrel));
    assert.ok(mod, `${barrel} did not parse as a module`);
    const got = checker.getExportsOfModule(mod).map((s) => {
      const t = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
      return `${s.name}:${t.flags & ts.SymbolFlags.Value ? "value" : "type"}`;
    }).sort();
    assert.deepEqual(got, [...m.surface].sort());
  });

  test(`${key}: the barrel only shrinks and every slice is under ${MAX_SLICE_LINES} lines`, () => {
    const n = lines(readFileSync(join(srcOf(m), `${m.name}.ts`), "utf8"));
    assert.ok(n <= m.barrelMax, `${m.name}.ts is ${n} lines, over its ${m.barrelMax} ratchet`);
    const over = sliceFiles(m).map((f) => [f, lines(readFileSync(join(srcOf(m), m.name, f), "utf8"))]).filter(([, c]) => c > MAX_SLICE_LINES);
    assert.deepEqual(over, [], "a slice past the cap is two responsibilities — cut it again");
    assert.ok(sliceFiles(m).length > 0, "the folder is empty");
  });

  test(`${key}: a move, not a copy — no definition twice; slices never import the barrel`, () => {
    const seen = new Map();
    const bad = [];
    const barrelDefs = defsIn(readFileSync(join(srcOf(m), `${m.name}.ts`), "utf8"));
    if (barrelDefs.length) bad.push(`the barrel defines ${barrelDefs.join(", ")}`);
    for (const f of sliceFiles(m)) {
      const t = readFileSync(join(srcOf(m), m.name, f), "utf8");
      for (const d of defsIn(t)) {
        if (seen.has(d)) bad.push(`${d} is defined in ${seen.get(d)} and ${f}`);
        seen.set(d, f);
      }
      if (new RegExp(`from "\\.\\./${m.name}\\.js"`).test(t)) bad.push(`${f} imports its barrel`);
    }
    assert.deepEqual(bad, []);
  });

  test(`${key}: nothing outside the folder names a slice`, () => {
    const bad = [];
    const re = new RegExp(`from "[^"]*/${m.name}/`);
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (p !== join(srcOf(m), m.name) && e.name !== "node_modules") walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(e.name)) continue;
        if (re.test(readFileSync(p, "utf8")) && !(e.name === `${m.name}.ts` && dir === srcOf(m))) bad.push(p.slice(ROOT.length));
      }
    };
    walk(srcOf(m));
    assert.deepEqual(bad, []);
  });
}
