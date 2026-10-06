// What `@waterplane/shared` exports from the intent model — names AND whether
// each is a value or a type — pinned, so splitting `src/intent.ts` into
// `src/intent/*.ts` cannot quietly add, drop or retype an export.
//
// Why the type checker and not `Object.keys(await import(dist/intent.js))`:
// half of this surface is TYPES (`Intent`, `IntentFacts`, `IntentVerdict`, …),
// which the dist module does not carry at all. A split that stops re-exporting
// a type nobody in host/web happens to name compiles everywhere and is still a
// changed contract. The checker sees both halves through the barrel's
// re-exports. It also catches the opposite drift: a helper the verdict needs
// from a sibling file (`wait`, `budgetHold`, the ladder's private sentences)
// must be EXPORTED there, and must not leak out through the barrel.
//
// Changing this list is a decision about the public API, never a way to make
// a refactor pass. Reasoning: docs/notes/shared-architecture.md.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const BARREL = fileURLToPath(new URL("../src/intent.ts", import.meta.url));

const SURFACE = [
  "AGENT_POSTED_WORDS:value", "AssessPayload:type", "AutoSlotFacts:type", "BlockReason:type",
  "BudgetPass:type", "BudgetWaiver:type", "BuildPayload:type", "CapturePayload:type",
  "HELD_MAX_MS:value", "INTENT_BLOCK_ORDER:value", "INTENT_MAX_ATTEMPTS:value", "INTENT_MAX_DIRS:value",
  "INTENT_MAX_NEEDS:value", "INTENT_MAX_STEPS:value", "Intent:type", "IntentFacts:type",
  "IntentKind:type", "IntentPayload:type", "IntentRequeue:type", "IntentResult:type",
  "IntentSettlement:type", "IntentTarget:type", "IntentTrigger:type", "IntentVerdict:type",
  "Lifecycle:type", "MANUAL_HOLD_TEXT:value", "ON_TIME_MS:value", "ORIGIN_AGENT:value",
  "ORIGIN_FANOUT_FOLLOWUP:value", "ORIGIN_FANOUT_RUN:value", "ORIGIN_FANOUT_TARGET:value", "ORIGIN_PEER_PREFIX:value",
  "ORIGIN_SCHEDULE_PREFIX:value", "ORIGIN_SCHEDULE_SWEEP:value", "ORIGIN_SCHEDULE_WORK:value", "REQUEUE_KEEP:value",
  "RESET_MATCH_MS:value", "autoSlotsWaitText:value", "budgetPassAt:value", "budgetPassOf:value",
  "budgetWaived:value", "budgetWaiverUntil:value", "busyIntentGroups:value", "cleanBudgetWaiver:value", "intentSerialHolders:value",
  "cleanIntentRow:value", "clockKey:value", "closeWhenDoneOf:value", "intentKind:value",
  "intentReasonText:value", "intentVerdict:value", "isAgentPosted:value", "isAssessRow:value",
  "isBacklogRow:value", "isBuildRow:value", "isCaptureRow:value", "isFanoutRow:value",
  "isLaunchRow:value", "isPeerPosted:value", "isScheduleRow:value", "isTimedWorkRow:value",
  "liveConvSession:value", "needsSlot:value", "peerOfOrigin:value", "queuesBacklogItem:value",
  "reopensConversation:value", "scheduleIdFromOrigin:value", "scheduleItemOrigin:value", "timedWorkKey:value",
];

test("the intent module exports exactly its pinned surface, values and types alike", () => {
  const program = ts.createProgram([BARREL], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const mod = checker.getSymbolAtLocation(program.getSourceFile(BARREL));
  assert.ok(mod, "src/intent.ts did not parse as a module");
  const got = checker.getExportsOfModule(mod).map((s) => {
    const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
    return `${s.name}:${target.flags & ts.SymbolFlags.Value ? "value" : "type"}`;
  }).sort();
  assert.deepEqual(got, [...SURFACE].sort());
});
