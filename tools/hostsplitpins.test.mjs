/**
 * Pins for splitting `capture.ts`, `backlog.ts` and `deliver.ts` (docs/notes/host-architecture.md,
 * "The capture and backlog slices", "The deliver slices"). The two files stay as barrels/facades over
 * `capture/` and `backlog/`; what must not change in a move is the EXPORT SURFACE,
 * read off the type checker (values and types alike), and the class's public
 * method list. Behaviour is held by the existing host tests
 * (`capture.test.mjs`, `backlog*.test.mjs`), run untouched before and after.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

function program(file) {
  return ts.createProgram([file], {
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022,
    noEmit: true, skipLibCheck: true, types: ["node"], strict: true,
  });
}

function surface(file) {
  const p = program(file);
  const checker = p.getTypeChecker();
  const mod = checker.getSymbolAtLocation(p.getSourceFile(file));
  assert.ok(mod, `${file} did not parse as a module`);
  return checker.getExportsOfModule(mod).map((s) => {
    const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
    return `${s.name}:${target.flags & ts.SymbolFlags.Value ? "value" : "type"}`;
  }).sort();
}

function members(file, className) {
  const p = program(file);
  const checker = p.getTypeChecker();
  const mod = checker.getSymbolAtLocation(p.getSourceFile(file));
  const cls = checker.getExportsOfModule(mod).find((s) => s.name === className);
  const t = checker.getDeclaredTypeOfSymbol(cls);
  return checker.getPropertiesOfType(t)
    .map((s) => s.name).sort();
}

const CAPTURE_SURFACE = ["CaptureEvents:type","CaptureManager:value","CleanTargetResult:type","EmitInput:type","VerdictInput:type","VerificationInput:type","classifyOverlay:value","cleanTarget:value","diffRecord:value","intentToCaptureRun:value","probeCaptureBackends:value","shouldEmit:value","verdictLine:value","verificationLevel:value"];
const BACKLOG_SURFACE = ["BACKLOG_LINGER_MS:value","BACKLOG_SESSIONS_MAX:value","BacklogManager:value","REAP_CEILING_MS:value","backlogTitle:value","chainDeliveryError:value","deliveryError:value","isBacklogTitle:value","retryableStep:value","withoutBacklogMark:value"];
const BACKLOG_MEMBERS = ["add","archive","autoSessionCount","autoSlotFacts","closesWhenDone","deliver","ensureRepoSession","fire","getAuto","idleMs","init","lingerSweep","list","markDone","openItemSession","reapAutoSession","remove","reorder","resolveRepoSession","rows","setAuto","setCloseWhenDoneDefault","setSmartPick","smartPickEnabled","smartPickList","swap","unmerge","update","waiting"];
const CAPTURE_MEMBERS = ["cancel","execute","getOutput","list","run","runsFor","save"];

test("capture.ts exports exactly its pinned surface", () => {
  assert.deepEqual(surface(here("../packages/host/src/capture.ts")), CAPTURE_SURFACE);
});
test("backlog.ts exports exactly its pinned surface", () => {
  assert.deepEqual(surface(here("../packages/host/src/backlog.ts")), BACKLOG_SURFACE);
});
test("BacklogManager keeps every public member it had", () => {
  const have = members(here("../packages/host/src/backlog.ts"), "BacklogManager");
  assert.deepEqual(BACKLOG_MEMBERS.filter((n) => !have.includes(n)), []);
});
test("CaptureManager keeps every public member it had", () => {
  const have = members(here("../packages/host/src/capture.ts"), "CaptureManager");
  assert.deepEqual(CAPTURE_MEMBERS.filter((n) => !have.includes(n)), []);
});

/**
 * `deliver.ts` is the ONE delivery implementation and stays its only way in: the
 * surface, and the exact signatures, read off the checker. A slice that leaked
 * out through the facade (`runDelivery`, a knob) is a second entry point.
 */
const DELIVER_SURFACE = ["DeliverOpts:type","DeliveryResult:type","deliverPrompt:value","deliverToNewSession:value"];
const DELIVER_FN = "(sessions: SessionManager, sessionId: string, text: string, historyKind?: \"prompt\" | \"command\" | \"backlog\", opts?: DeliverOpts) => Promise<DeliveryResult>";
const DELIVER_SIGS = {
  deliverPrompt: DELIVER_FN,
  deliverToNewSession: DELIVER_FN,
  DeliveryResult: '"ok" | "retry" | "unconfirmed" | "unsubmitted"',
  DeliverOpts: [
    "interactive: boolean | undefined",
    "ackId: string | undefined",
    "watch: boolean | undefined",
    'audit: { source: SentSource; actor?: "auto" | "user" | undefined; detail?: string | undefined; } | undefined',
    "onDetail: ((detail: string) => void) | undefined",
    "view: SendView | undefined",
  ],
};
test("deliver.ts exports exactly its pinned surface", () => {
  assert.deepEqual(surface(here("../packages/host/src/deliver.ts")), DELIVER_SURFACE);
});
test("deliver.ts keeps its exact signatures", () => {
  const file = here("../packages/host/src/deliver.ts");
  const p = program(file);
  const c = p.getTypeChecker();
  const NT = ts.TypeFormatFlags.NoTruncation;
  const got = {};
  for (const s0 of c.getExportsOfModule(c.getSymbolAtLocation(p.getSourceFile(file)))) {
    const s = s0.flags & ts.SymbolFlags.Alias ? c.getAliasedSymbol(s0) : s0;
    if (s.flags & ts.SymbolFlags.Value) { got[s0.name] = c.typeToString(c.getTypeOfSymbol(s), undefined, NT); continue; }
    const t = c.getDeclaredTypeOfSymbol(s);
    got[s0.name] = t.isUnion()
      ? c.typeToString(t, undefined, NT | ts.TypeFormatFlags.InTypeAlias)
      : c.getPropertiesOfType(t).map((x) => `${x.name}: ${c.typeToString(c.getTypeOfSymbol(x), undefined, NT)}`);
  }
  assert.deepEqual(got, DELIVER_SIGS);
});
