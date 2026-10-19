// What @waterplane/shared exports from sessioncost, schedule, queue and clihealth — names AND
// whether each is a value or a type — pinned through the type checker, so cutting each into a
// folder of slices cannot add, drop or retype an export (nor leak a slice-internal helper through
// the barrel). Written against the unsplit files before the first move. Changing a list is a
// decision about the public API, never a way to make a refactor pass.
// Reasoning: docs/notes/shared-architecture.md.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SURFACES = {
  sessioncost: [
    "AGENT_LARGE_TOK:value", "AGENT_LIVE_MS:value", "CACHE_COLD_AFTER_MS:value",
    "CACHE_TTL_MS:value", "COST_WHERE:value", "COST_WHERE_HEAD:value",
    "CacheAge:type", "ColdStarts:type", "CompactionReading:type",
    "CompactionRow:type", "DOLLARS_WHY:value", "DOLLARS_WHY_HEAD:value",
    "MIN_TURNS:value", "MULT_HEAVY:value", "MULT_STEEP:value",
    "MULT_WARM:value", "REBUILD_READ:value", "REBUILD_WROTE:value",
    "SessionCostInput:type", "SessionCostLevel:type", "SessionCostReading:type",
    "WEEK_CAL_MIN_PCT:value", "agentAdvice:value", "breakEvenTurns:value",
    "cacheLikelyCold:value", "coldStartChip:value", "coldStartText:value",
    "compactionCostText:value", "compactionCountText:value", "compactionMethodText:value",
    "compactionPendingText:value", "compactionRatioText:value", "compactionReading:value",
    "compactionRowFacts:value", "compactionRowLabel:value", "compactionSavedText:value",
    "compactionUnmeasuredText:value", "compactionWindowText:value", "costChip:value",
    "costDoorsText:value", "costText:value", "fmtMultiple:value",
    "fmtTok:value", "isColdRebuild:value", "liveAgentText:value",
    "nextTurnText:value", "seriesCostFields:value", "sessionCost:value",
    "sessionCostOf:value", "sessionCostOfSeries:value", "turnCostParts:value",
    "turnTokensText:value", "usageChip:value", "usageText:value",
    "weekShareText:value", "weekUsdPerPct:value",
  ],
  schedule: [
    "DAY_LABELS:value", "DEFAULT_GRACE_MIN:value", "HORIZON_LABEL:value",
    "HorizonBucket:type", "INTENT_MAX_STEPS:value", "RuleAnchor:type",
    "SPENT_ONCE_TEXT:value", "ScheduleAction:type", "ScheduleEntry:type",
    "ScheduleHorizon:type", "ScheduleResult:type", "ScheduleRule:type",
    "WhenShape:type", "WindowResets:type", "afterWords:value",
    "cleanAction:value", "cleanRule:value", "composeRule:value",
    "describeHours:value", "describeRule:value", "fmtOffset:value",
    "fmtWhen:value", "horizonBucket:value", "horizonLead:value",
    "horizonWords:value", "hoursOpenFrom:value", "hoursZone:value",
    "inHours:value", "inWords:value", "isSpentOnce:value",
    "isStandingSchedule:value", "nextFireAt:value", "ruleAnchor:value",
    "ruleRecurs:value", "scheduleHorizon:value", "typedName:value",
    "wallClockToEpoch:value", "whenWords:value", "windowCondition:value",
    "windowPct:value", "windowResetAt:value", "zoneOffsetMs:value",
  ],
  queue: [
    "BlockedEntry:type", "LaneSessionState:type", "MIN_TRY_MS:value",
    "RETRY_BACKOFF_MAX_MS:value", "RETRY_BACKOFF_MS:value", "RETRY_ROUND_MAX_MS:value",
    "RETRY_ROUND_MS:value", "RetargetableEntry:type", "SERIAL_STARTUP_MS:value", "SERIAL_WAIT_TEXT:value",
    "SelectSendableOpts:type", "SendBlockReason:type", "SendMode:type",
    "SendPlan:type", "SendQueueEntry:type", "SendStatus:type",
    "SerialHolder:type", "SerialSessionState:type", "SerialWatch:type", "SessionWall:type",
    "adoptReferencedUploads:value", "answerInsertAt:value", "applyRelease:value",
    "bindPendingSession:value", "blockedReasonText:value", "busySerialGroups:value",
    "canRetarget:value", "danglingUploadRefs:value", "laneBusy:value",
    "laneEntries:value", "moveInLane:value", "ownedPendingCreates:value",
    "queueIdleReason:value", "retargetEntry:value", "retryDelay:value",
    "roundDelay:value", "selectSendable:value", "sendEligible:value",
    "serialGroup:value", "serialHolders:value", "serialLead:value", "serialWaitText:value", "sessionWall:value", "uploadAttemptWasted:value",
  ],
  clihealth: [
    "BROKEN_MISSES:value", "CLI_SIGNALS:value", "CliHealth:type",
    "CliSignalId:type", "CliSignalSpec:type", "DEFAULT_THRESHOLDS:value",
    "DEGRADED_MISSES:value", "HealthCheck:type", "HealthObservation:type",
    "HealthOutcome:type", "HealthRollup:type", "HealthThresholds:type",
    "HealthVerdict:type", "ObserveOpts:type", "RATE_BROKEN:value",
    "RATE_DEGRADED:value", "RATE_MAX_AGE_MS:value", "RATE_MIN_SAMPLES:value",
    "RATE_WINDOW:value", "SAMPLE_CAP:value", "SIGNAL_FORGET_MS:value",
    "SampleMode:type", "SignalRecord:type", "VIA_CAP:value",
    "agoText:value", "blankSignal:value", "captureSample:value",
    "cleanHealth:value", "clearSeen:value", "emptyHealth:value", "healthRollup:value",
    "healthSentence:value", "noteCliVersion:value", "observe:value",
    "rearmForVersion:value", "redactSample:value", "shapeOf:value",
    "signalSpec:value", "signalVerdict:value", "supersededByGood:value",
    "thresholdsFor:value", "unhealthySignals:value",
  ],
};

for (const [mod, SURFACE] of Object.entries(SURFACES)) {
  test(`${mod}.ts exports exactly its pinned surface, values and types alike`, () => {
    const file = fileURLToPath(new URL(`../src/${mod}.ts`, import.meta.url));
    const program = ts.createProgram([file], {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      noEmit: true,
      skipLibCheck: true,
    });
    const checker = program.getTypeChecker();
    const sym = checker.getSymbolAtLocation(program.getSourceFile(file));
    assert.ok(sym, `${mod}.ts did not parse as a module`);
    const got = checker.getExportsOfModule(sym).map((s) => {
      const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
      return `${s.name}:${target.flags & ts.SymbolFlags.Value ? "value" : "type"}`;
    }).sort();
    assert.deepEqual(got, [...SURFACE].sort());
  });
}
