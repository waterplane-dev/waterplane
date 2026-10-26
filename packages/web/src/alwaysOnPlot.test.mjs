/**
 * The always-on strip's geometry: it agrees with the chip filter, never draws an unsized row as a
 * length, and its bands print the numbers the lead sentence prints.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { alwaysOnRows, alwaysOnTotalsWords, claudeWeightInput, weighContext, fmtCount, MCP_UNSIZED } from "@waterplane/shared";
import { aoPlot, aoPick, aoMarkerFold, aoHeadWords, aoSegWords, aoLeftOutWords, everyTurnChars } from "./alwaysOnPlot.ts";

const always = (chars, readers = ["claude"]) => ({ readers, when: { kind: "always" }, chars });
const onDemand = (chars) => ({ readers: ["claude"], when: { kind: "on-demand" }, chars });

const FILES = [
  { path: "CLAUDE.md", kind: "CLAUDE.md", parts: [always(12000, ["claude", "copilot"])] },
  { path: ".claude/skills/a/SKILL.md", kind: "skill", parts: [always(400), onDemand(9000)] },
  { path: "CLAUDE.local.md", kind: "CLAUDE.local.md", parts: [always(2000)] },
  { path: ".claude/agents/rev.md", kind: "subagent", parts: [always(300)] },
  { path: ".github/copilot-instructions.md", kind: "Copilot instructions", parts: [always(800, ["copilot"])] },
  { path: ".claude/rules/web.md", kind: "rule", parts: [{ readers: ["claude"], when: { kind: "scoped", globs: ["web/**"] }, chars: 700 }] },
  { path: ".mcp.json", kind: "MCP server github", parts: [], unsized: MCP_UNSIZED },
  { path: "CLAUDE.md", kind: "user CLAUDE.md", scope: "desktop", parts: [always(3000)] },
  { path: "plugins", kind: "plugin skill (x)", scope: "desktop", parts: [], unsized: "a plugin pack not on disk" },
];
const BOTH = ["repo", "desktop"];

test("every row of the shown scopes is drawn, idle or a marker — the chips' count", () => {
  for (const scopes of [BOTH, ["repo"], ["desktop"]]) {
    const p = aoPlot(FILES, scopes);
    const chip = alwaysOnRows(FILES).filter((r) => scopes.includes(r.scope)).length;
    assert.equal(p.rows, chip);
    assert.equal(p.segs.length + p.idle + p.markers.length, chip);
  }
});

test("a cut draws only its own scope", () => {
  assert.ok(aoPlot(FILES, ["repo"]).segs.every((s) => s.scope === "repo"));
  assert.ok(aoPlot(FILES, ["desktop"]).segs.every((s) => s.scope === "desktop"));
  assert.deepEqual(aoPlot(FILES, ["desktop"]).bands.map((b) => b.band), ["desktop"]);
});

test("an unsized row is a marker, never a segment of any width", () => {
  const p = aoPlot(FILES, BOTH);
  assert.deepEqual(p.markers.map((m) => m.kind), ["MCP server github", "plugin skill (x)"]);
  assert.ok(!p.segs.some((s) => s.kind.startsWith("MCP") || s.kind.startsWith("plugin")));
});

test("bands: counted, listed, desktop in order; the counted band is the threshold's figure", () => {
  const p = aoPlot(FILES, BOTH);
  assert.deepEqual(p.bands.map((b) => b.band), ["counted", "listed", "desktop"]);
  const repo = FILES.filter((f) => f.scope !== "desktop");
  assert.equal(p.bands[0].chars, weighContext(claudeWeightInput(repo)).alwaysOnChars);
  assert.equal(p.bands[1].chars, 2300);
  assert.equal(p.bands[2].chars, 3000);
  // The lead sentence prints the same counted and listed figures.
  const lead = alwaysOnTotalsWords(FILES, fmtCount);
  assert.ok(lead.includes(fmtCount(p.bands[0].chars)) && lead.includes(fmtCount(p.bands[1].chars)), lead);
});

test("geometry tiles 0..100 with no gap, largest first inside a band", () => {
  const p = aoPlot(FILES, BOTH);
  let x = 0;
  for (const s of p.segs) { assert.ok(Math.abs(s.x - x) < 1e-9); x += s.w; }
  assert.ok(Math.abs(x - 100) < 1e-9);
  assert.equal(p.total, 12000 + 400 + 2000 + 300 + 3000);
  assert.deepEqual(p.segs.map((s) => s.path), ["CLAUDE.md", ".claude/skills/a/SKILL.md", "CLAUDE.local.md", ".claude/agents/rev.md", "CLAUDE.md"]);
});

test("a Copilot-only or scoped-only file carries nothing every turn: idle, not a segment", () => {
  assert.equal(everyTurnChars(FILES[4]), 0);
  assert.equal(aoPlot(FILES, ["repo"]).idle, 2);
});

test("pick: the segment under the finger, null off the bar", () => {
  const p = aoPlot(FILES, BOTH);
  assert.equal(aoPick(p.segs, 0), 0);
  assert.equal(aoPick(p.segs, 1), p.segs.length - 1);
  assert.equal(aoPick(p.segs, 0.99), p.segs.length - 1);
  assert.equal(aoPick(p.segs, -0.1), null);
  assert.equal(aoPick(p.segs, 1.2), null);
  assert.equal(aoPick([], 0.5), null);
});

test("seams only between two segments wide enough to show one", () => {
  const p = aoPlot(FILES, BOTH);
  for (let i = 0; i < p.segs.length - 1; i++) {
    if (p.segs[i].seam) assert.ok(p.segs[i].w >= 1.5 && p.segs[i + 1].w >= 1.5);
  }
  assert.equal(p.segs.at(-1).seam, false);
});

test("words: tokens are always `~`, the left-out sentence counts n of N", () => {
  const p = aoPlot(FILES, BOTH);
  assert.match(aoHeadWords(p, fmtCount), /^Every turn: ~/);
  assert.match(aoSegWords(p.segs[0], p.total, (s) => s.path, fmtCount), /^CLAUDE.md · ~3k tokens \(12k chars, 68%\) · counted by the threshold row$/);
  assert.match(aoLeftOutWords(p), /^5 of 9 rows drawn; 2 rows carry nothing.*2 rows have no size/);
  assert.equal(aoLeftOutWords(aoPlot(FILES.slice(0, 2), ["repo"])), null);
  assert.equal(aoHeadWords(aoPlot([], BOTH), fmtCount), "Nothing from these files reaches Claude Code on every turn.");
});

test("marker fold names `cap` and counts the rest", () => {
  const ms = Array.from({ length: 9 }, (_, i) => ({ key: `${i}`, path: "x", kind: `MCP server s${i}`, scope: "repo", why: "" }));
  const f = aoMarkerFold(ms, 6);
  assert.equal(f.shown.length, 6);
  assert.equal(f.more, 3);
});
