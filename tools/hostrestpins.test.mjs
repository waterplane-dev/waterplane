// The export surfaces of files that were split into slices — routes/work.ts and
// sidecar.ts (a private extension pins its own in its test/) — names AND value/type,
// read off the type checker (intentsurface.test.mjs's method), so a split cannot add,
// drop or retype an export. Changing a list is a decision about the public API.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSurface } from "./exportsurface.mjs";

const at = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

const PINS = {
  "packages/host/src/routes/work.ts": ["workRoutes:value"],
  "packages/host/src/sidecar.ts": ["ChatRequest:type","ClaudeRoute:type","EnvelopeUsage:type","HeadlessRequest:type","HeadlessRun:type","NameRequest:type","NameRun:type","OpenAIRoute:type","RefusedRoute:type","SIDECAR_ENV:value","SidecarEngine:type","SidecarPlan:type","SidecarTask:type","SummaryRequest:type","ToolTaskRun:type","chatCompletion:value","claudeConfigPath:value","completionText:value","envelopeUsage:value","parseSidecarSpec:value","resetSidecarWarnings:value","runCommitTask:value","runExplainTask:value","runHeadlessClaude:value","runNameTask:value","runSummaryTask:value","runToolTask:value","sidecarPlan:value","trustRefusal:value","workspaceTrust:value"],
};

for (const [rel, want] of Object.entries(PINS)) {
  test(`${rel} exports exactly its pinned surface`, () => {
    assertSurface(at(rel), want);
  });
}

// The router's key set AND order (HANDLED = Object.keys(ROUTES)), off dist: routes/work/ slices
// are spread back into workRoutes and must hand the table over unchanged.
const HANDLED = ["session.list","recent.list","recent.clear","closed.clear","session.create","session.fork","session.attach","session.detach","session.input","shell.kill","input.settle","delivery.list","session.resize","session.kill","session.remove","session.closecheck","session.rename","session.name","session.mode","session.budget.set","session.remoteControl","session.star","session.followup","session.ackAsking","session.pin","session.record","session.history","session.search","limit.setAuto","limit.session","limit.first","limit.resume","limit.setMode","fanout.list","fanout.run","fanout.followup","backlog.list","backlog.add","backlog.remove","backlog.fire","backlog.done","backlog.update","backlog.swap","backlog.reorder","backlog.setAuto","backlog.name","backlog.openRepoSession","backlog.archive","backlog.check","backlog.validate","backlog.nextStep","backlog.continue","build.list","build.save","build.run","build.options","build.cancel","artifacts.get","artifacts.save","build.scan","capture.list","capture.save","capture.run","capture.cancel","assess.run","assess.apply","assess.discard","assess.state","pull.get","pull.save","pull.list","pull.add","pull.dismiss","launch.list","launch.cancel","launch.run","schedule.list","schedule.save","schedule.remove","schedule.setEnabled","schedule.run","schedule.skipNext","intent.list","intent.post","intent.run","intent.requeue","intent.update","intent.waive","intent.retarget","intent.cancel","intent.dismiss","ping","host.halt","hello","update.status","update.check","update.apply","updates.get","updates.check","updates.apply","usage.get","usage.refresh","auth.set","auth.clear","auth.gateTailscale","auth.get","plugin.list","plugin.set","plugin.enable","plugin.action","plugin.call","plugin.sessionToggle","plugin.sessionAnswer","stream.open","stream.params","stream.input","stream.ack","stream.keyframe","stream.close","decisions.get","decisions.archive","decisions.delete","decisions.archiveAll","sent.get","sent.clear","install.get","install.report","net.stalls","settings.get","settings.set","meter.get","notification.get","notification.clear","notification.handle","notify.prefs.set","budget.get","clihealth.get","clihealth.clear","localrt.watch","localrt.evict","backends.recheck","budget.set","billing.get","billing.set"];

test("the route table keeps every message type, in order", async () => {
  const { HANDLED: got } = await import("../packages/host/dist/routes/index.js");
  assert.deepEqual([...got], HANDLED);
});

// ── The loopback gate is ONE function, and /api/slash is contained ──────────
// `isLoopbackAddr` was a second loopback predicate with no callers and without
// `PROXY_HEADERS`: behind `tailscale serve` every tailnet request arrives from
// loopback, so it answered "this machine" for the phone. `net.ts`'s
// `localProcessRefusal` is the only gate; a second one is a trap for the next
// author. And `GET /api/slash?cwd=` lists `<cwd>/.claude/commands`, so it must
// go through `containRepoDir` (scripts/e2e-rootguard.mjs asserts the behaviour).
function hostSources(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...hostSources(p));
    else if (/\.(ts|tsx|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

test("no isLoopbackAddr in packages/host/src: net.ts localProcessRefusal is the one gate", () => {
  const hits = hostSources(at("packages/host/src")).filter((f) => readFileSync(f, "utf8").includes("isLoopbackAddr"));
  assert.deepEqual(hits, []);
});

test("/api/slash resolves its cwd through containRepoDir", () => {
  const src = readFileSync(at("packages/host/src/routes/apisession.ts"), "utf8");
  const at_ = src.indexOf('"/api/slash"');
  assert.ok(at_ > 0, "the /api/slash route moved; update this pin");
  assert.match(src.slice(at_, at_ + 400), /containRepoDir\(\s*url\.searchParams\.get\("cwd"\)/);
});
