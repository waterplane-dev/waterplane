/**
 * Pins for splitting `pull.ts` and `link.ts` (docs/notes/pulllink-architecture.md).
 *
 * Both keep their paths as barrels over `pull/` and `link/`. A move must not
 * change what an importer can see, so the EXPORT SURFACE is read off the type
 * checker (values and types alike), and for the pull manager the members of
 * the `pulls` instance that were public before the split must stay public.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const SRC = (f) => here(`../packages/web/src/${f}`);

function program(file) {
  return ts.createProgram([file], {
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true,
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

const PULL = [
  "LocalPull:type", "PullRecord:type", "PullState:type", "SaveResult:type", "autoPull:value",
  "localPullId:value", "onServiceWorkerPullMessage:value", "pulls:value", "setAutoPull:value",
];

const LINK = [
  "HostLinkStats:type", "LinkLog:type", "LinkPulse:type", "LinkSnapshot:type", "LinkStatus:type",
  "LinkSync:type", "LinkTraffic:type", "NetOp:type", "PULSE_CAP:value", "PulseSample:type",
  "PulseSource:type", "PulseSummary:type", "SyncPart:type", "TrafficDir:type", "deviceId:value",
  "fmtMs:value", "fmtRate:value", "fmtSince:value", "fmtTotal:value", "installLinkMeters:value",
  "labelForUrl:value", "lastSyncEver:value", "linkOnline:value", "linkSnapshot:value",
  "linkStatus:value", "linkVerdict:value", "netBegin:value", "noteAckTimeout:value",
  "noteHostSeen:value", "noteLinkStatus:value", "noteOutstanding:value", "noteReload:value",
  "noteRtt:value", "noteSendConfirmed:value", "noteSendExpired:value", "noteSendFailed:value",
  "noteStuckSends:value", "noteSynced:value", "noteTraffic:value", "pulseEnabled:value",
  "resetLinkWindow:value", "rollup:value", "rttP95:value", "setPulseEnabled:value",
  "startLinkProbes:value", "startLinkReporting:value", "subscribeLink:value", "summarize:value",
  "syncSnapshot:value", "trafficSnapshot:value", "useLink:value", "whenText:value",
];

const MANAGER_PUBLIC = [
  "add", "addLocal", "dropBytes", "emit", "findFor", "get", "list", "noteBackgroundResult", "objectUrl",
  "pause", "pump", "remove", "resumeAll", "retry", "save", "start", "subscribe", "sync",
  "verifyAllSaved", "verifySaved", "whyIdle",
];

test("pull.ts exports exactly its pinned surface, values and types alike", () => {
  assert.deepEqual(surface(SRC("pull.ts")), [...PULL].sort());
});

test("link.ts exports exactly its pinned surface, values and types alike", () => {
  assert.deepEqual(surface(SRC("link.ts")), [...LINK].sort());
});

test("the pull manager keeps every member that was public before the split", () => {
  const file = SRC("pull.ts");
  const p = program(file);
  const checker = p.getTypeChecker();
  const mod = checker.getSymbolAtLocation(p.getSourceFile(file));
  const sym = checker.getExportsOfModule(mod).find((s) => s.name === "pulls");
  const names = checker.getTypeOfSymbol(sym).getProperties().map((m) => m.name);
  const missing = MANAGER_PUBLIC.filter((n) => !names.includes(n));
  assert.deepEqual(missing, []);
});
