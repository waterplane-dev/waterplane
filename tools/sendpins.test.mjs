/**
 * Pins for splitting the send sheet (docs/notes/send-architecture.md).
 *
 * `SendSheet.tsx` was one ~1090-line component and `sendIntent.ts` ~1150 lines
 * of vocabulary and rules. Both are cut into folders (`send/`, `sendIntent/`).
 * A copy-then-delete move can DUPLICATE a send (a second `onSend`, a second
 * draft clear) or DROP an export every importer needs. So:
 *
 *  - P1: `sendIntent.ts` exports exactly the names it did, values and types
 *    alike — read off the type checker, because half the surface is types
 *    (same method as packages/shared/test/intentsurface.test.mjs).
 *  - P2: the sheet's side-effect sites are counted as TEXT over `SendSheet.tsx`
 *    + `send/**`, file-agnostic: the same counts hold before, during and after.
 *
 * Changing a list or count here is a behaviour decision, named in the commit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "packages", "web", "src");

const SURFACE = [
  "CHAIN_EMPTY:value", "CHAIN_NOTE:value", "CHAIN_RECENT_MS:value", "DEVICE_TZ:value", "EMPTY_PROMPT_BLOCKER:value",
  "GRACES:value", "GUARD_LABEL:value", "LEADS:value", "LEAD_MAX_MIN:value", "PCT_LEFTS:value", "QUEUES_ITEM_RUN_NOTE:value",
  "RETIME_NOW_SEG:value", "SEND_DRAFT:value", "SKIP_QUEUE_BUSY_NOTE:value", "SendIntent:type", "SendNames:type",
  "SendResume:type", "SendSeed:type", "SendTarget:type", "SendWhen:type", "WHEN_EDIT_BUILD:value",
  "WHEN_EDIT_RUNNING:value", "WHEN_EDIT_SWEEP:value", "WHEN_PATCH_OFFLINE:value", "WINDOW_LABEL:value",
  "WhenRoute:type", "afterWords:value", "anchorWindowOf:value", "atClock:value", "budgetHeldIds:value",
  "budgetOfTarget:value", "busyInCheckout:value", "chainCandidates:value", "chainOkWords:value",
  "clockSessionNote:value", "flagWhenDoneOf:value", "flagWhenDoneOffered:value", "fmtWhen:value", "guardWindowOf:value", "guardWords:value", "hoursWords:value",
  "inWords:value", "inboxRefs:value", "isBudgetHeld:value", "launchClause:value", "launchOfTarget:value",
  "launchWords:value", "leadChoices:value", "leadLabel:value",
  "leadOk:value", "leadWords:value", "offlineLabel:value", "onceIn:value",
  "pastBudgetConfirm:value", "pastBudgetLabel:value", "pastBudgetNote:value", "pastBudgetToast:value",
  "pctChoices:value", "pctOk:value", "pctWords:value", "previewOf:value", "quickTimes:value", "resumeWhen:value",
  "retimeBlocker:value", "retimeHeldWords:value", "retimeWhenLabel:value", "seedAfterRescue:value",
  "sendBlocker:value", "sendLabel:value", "sequentialMeans:value", "skipQueueNote:value", "targetWords:value",
  "toLocalInput:value", "whenPatchToast:value", "whenRoute:value", "whenWords:value", "windowIn:value",
  "withBudget:value", "withLaunch:value",
  "withoutLaunch:value",
];

test("P1: sendIntent.ts exports exactly its pinned surface, values and types alike", () => {
  const barrel = join(SRC, "sendIntent.ts");
  const program = ts.createProgram([barrel], {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const mod = checker.getSymbolAtLocation(program.getSourceFile(barrel));
  assert.ok(mod, "sendIntent.ts did not parse as a module");
  const got = checker.getExportsOfModule(mod).map((s) => {
    const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
    return `${s.name}:${target.flags & ts.SymbolFlags.Value ? "value" : "type"}`;
  }).sort();
  assert.deepEqual(got, [...SURFACE].sort());
});

/** `SendSheet.tsx` plus everything under `send/` (tests excluded), as text. */
function sheet() {
  const parts = [readFileSync(join(SRC, "SendSheet.tsx"), "utf8")];
  const dir = join(SRC, "send");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir, { recursive: true }).filter((f) => /\.(ts|tsx)$/.test(f)).sort()) {
      parts.push(readFileSync(join(dir, f), "utf8"));
    }
  }
  return parts.join("\n");
}
const count = (re) => [...sheet().matchAll(re)].length;

test("P2: one post, one draft clear, one draft write path, one attach hand-off", () => {
  assert.equal(count(/\bonSend\(/g), 1, "the sheet posts from exactly one site");
  assert.equal(count(/track\("action:send\.post"\)/g), 1);
  assert.equal(count(/saveSheetDraft\(draftKey, ""\)/g), 1, "the draft is cleared once, after a post");
  assert.equal(count(/saveSheetDraft\(/g), 3, "per-keystroke write, mount-effect write, the clear");
  assert.equal(count(/loadSheetDraft\(/g), 1, "the draft is read once, at mount");
  assert.equal(count(/\bonAnnotate\(/g), 1);
  assert.equal(count(/\bonAttach\(/g), 1);
  assert.equal(count(/\bonDecide\b/g) >= 1, true);
  assert.equal(count(/decideRef\.current\?\.\(/g), 1, "the decision is reported from one effect");
  assert.equal(count(/lsSet\(LS\.schedPctLeft/g), 1);
});

test("P3: the sheet's never-do list", () => {
  const all = sheet();
  assert.doesNotMatch(all, /window\.confirm|\bconfirm\(/, "no native modal");
  assert.equal(count(/<textarea/g), 0, "one prompt textarea lives in PromptComposer.tsx");
  assert.equal(count(/new WebSocket|sendWs\(|ws\.send\(/g), 0, "no send path of its own");
});

test("P4: one SendSheet component, taking the same props", () => {
  assert.equal(count(/^export function SendSheet\(/gm), 1);
  const text = readFileSync(join(SRC, "SendSheet.tsx"), "utf8");
  assert.match(text, /export function SendSheet\(/);
});
