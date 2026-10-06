// The export surfaces of files that were split into slices — routes/work.ts and
// sidecar.ts (a private extension pins its own in its test/) — names AND value/type,
// read off the type checker (intentsurface.test.mjs's method), so a split cannot add,
// drop or retype an export. Changing a list is a decision about the public API.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const at = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

function surface(file) {
  const program = ts.createProgram([file], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const mod = checker.getSymbolAtLocation(program.getSourceFile(file));
  assert.ok(mod, `${file} did not parse as a module`);
  return checker.getExportsOfModule(mod).map((s) => {
    const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
    return `${s.name}:${target.flags & ts.SymbolFlags.Value ? "value" : "type"}`;
  }).sort();
}

const PINS = {
  "packages/host/src/routes/work.ts": ["workRoutes:value"],
  "packages/host/src/sidecar.ts": ["ChatRequest:type","ClaudeRoute:type","EnvelopeUsage:type","HeadlessRequest:type","HeadlessRun:type","NameRequest:type","NameRun:type","OpenAIRoute:type","RefusedRoute:type","SIDECAR_ENV:value","SidecarEngine:type","SidecarPlan:type","SidecarTask:type","SmartPickRequest:type","SmartPickRun:type","SummaryRequest:type","ToolTaskRun:type","chatCompletion:value","claudeConfigPath:value","completionText:value","envelopeUsage:value","parseSidecarSpec:value","resetSidecarWarnings:value","runCommitTask:value","runHeadlessClaude:value","runNameTask:value","runSmartPickTask:value","runSummaryTask:value","runToolTask:value","sidecarPlan:value","trustRefusal:value","workspaceTrust:value"],
};

for (const [rel, want] of Object.entries(PINS)) {
  test(`${rel} exports exactly its pinned surface`, () => {
    assert.deepEqual(surface(at(rel)), [...want].sort());
  });
}

// The router's key set AND order (HANDLED = Object.keys(ROUTES)), off dist: routes/work/ slices
// are spread back into workRoutes and must hand the table over unchanged.
const HANDLED = ["session.list","recent.list","recent.clear","closed.clear","session.create","session.fork","session.attach","session.detach","session.input","shell.kill","input.settle","delivery.list","session.resize","session.kill","session.remove","session.closecheck","session.rename","session.name","session.budget.set","session.remoteControl","session.star","session.ackAsking","session.pin","session.record","session.history","session.search","limit.setAuto","limit.session","limit.first","limit.resume","limit.setMode","fanout.list","fanout.run","fanout.followup","backlog.list","backlog.add","backlog.remove","backlog.fire","backlog.done","backlog.update","backlog.swap","backlog.reorder","backlog.setAuto","backlog.setSmartPick","backlog.name","backlog.unmerge","backlog.openRepoSession","backlog.archive","backlog.check","backlog.validate","backlog.nextStep","backlog.continue","build.list","build.save","build.run","build.options","build.cancel","artifacts.get","artifacts.save","build.scan","capture.list","capture.save","capture.run","capture.cancel","assess.run","assess.apply","assess.discard","assess.state","pull.get","pull.save","pull.list","pull.add","pull.dismiss","launch.list","launch.cancel","launch.run","schedule.list","schedule.save","schedule.remove","schedule.setEnabled","schedule.run","schedule.skipNext","intent.list","intent.post","intent.run","intent.requeue","intent.update","intent.waive","intent.retarget","intent.cancel","intent.dismiss","ping","hello","update.status","update.check","update.apply","usage.get","usage.refresh","auth.set","auth.clear","auth.gateTailscale","auth.get","plugin.list","plugin.set","plugin.enable","plugin.action","plugin.call","plugin.sessionToggle","plugin.sessionAnswer","decisions.get","decisions.archive","decisions.delete","decisions.archiveAll","sent.get","sent.clear","install.get","install.report","settings.get","settings.set","meter.get","notification.get","notification.clear","notify.prefs.set","budget.get","clihealth.get","localrt.watch","localrt.evict","backends.recheck","budget.set"];

test("the route table keeps every message type, in order", async () => {
  const { HANDLED: got } = await import("../packages/host/dist/routes/index.js");
  assert.deepEqual([...got], HANDLED);
});
