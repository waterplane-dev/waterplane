// Skills and plugins switch, read side (docs/analysis/skills-switch/PLAN.md P2): weight, state per
// level, plugin skills read-only, an unreadable layer says so, refs by name. Temp config dir + stub claude.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "wp-skillinv-"));
const cfg = join(root, "cfg");
const wt = join(root, "repo");
const plug = join(cfg, "plugins", "synced", "acct", "sales~g2");
const stub = join(root, "claude-stub.sh");
const skill = (dir, name, desc, body = "body text") => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n${body}\n`);
};
skill(join(cfg, "skills", "mine"), "mine", "My own skill");
skill(join(cfg, "skills", "synced", "acct", "docx"), "docx", "Word files");
skill(join(wt, ".claude", "skills", "proj"), "proj", "Project skill");
skill(join(plug, "skills", "account-context"), "account-context", "360 view");
writeFileSync(join(plug, ".mcp.json"), JSON.stringify({ mcpServers: { a: {}, b: {} } }));
mkdirSync(join(wt, ".claude"), { recursive: true });
writeFileSync(join(cfg, "settings.json"), JSON.stringify({ skillOverrides: { mine: "off", proj: "name-only" }, enabledPlugins: { "sales@synced": false } }));
writeFileSync(join(wt, ".claude", "settings.json"), JSON.stringify({ skillOverrides: { mine: "on" } }));
writeFileSync(join(wt, ".claude", "settings.local.json"), "{ not json");
writeFileSync(join(wt, "CLAUDE.md"), "Use mine for things. Not minefield.\n");
writeFileSync(stub, `#!/bin/sh\necho '${JSON.stringify([{ id: "sales@synced", version: "2.1.0", scope: "synced", enabled: true, installPath: plug }])}'\n`);
chmodSync(stub, 0o755);
process.env.CLAUDE_CONFIG_DIR = cfg;
process.env.WATERPLANE_CLAUDE_BIN = stub;

const { buildInventory, resetPluginListCache } = await import("../dist/skills/skillinventory.js");
const { repoReferences } = await import("../dist/skills/skillrefs.js");
const { weightOf } = await import("../dist/skills/skillweight.js");

test("global only: personal, synced-skill and plugin rows, no repo layers", async () => {
  resetPluginListCache();
  const { doc } = await buildInventory();
  assert.equal(doc.layers.length, 1);
  const mine = doc.rows.find((r) => r.id === "mine");
  assert.equal(mine.effective, "off");
  assert.equal(mine.from, "global");
  assert.ok(doc.rows.find((r) => r.id === "anthropic-skills:docx" && r.source === "synced-skill"));
  assert.equal(doc.rows.find((r) => r.id === "proj"), undefined);
});

test("repo: local beats shared beats global; an unreadable layer says so and counts empty", async () => {
  resetPluginListCache();
  const { doc } = await buildInventory({ worktree: wt, repoId: "r1" });
  const bad = doc.layers.find((l) => l.level === "repo-local");
  assert.equal(bad.readable, false);
  assert.match(bad.why, /not valid JSON/);
  const mine = doc.rows.find((r) => r.id === "mine");
  assert.equal(mine.effective, "on");
  assert.equal(mine.from, "repo-shared");
  assert.deepEqual(mine.set, { global: "off", "repo-shared": "on" });
  assert.equal(doc.rows.find((r) => r.id === "proj").effective, "name-only");
  assert.equal(doc.repoId, "r1");
});

test("plugin: one switch, skills read-only, weight is the sum of its lines, mcp counted by name", async () => {
  resetPluginListCache();
  const { doc } = await buildInventory({ worktree: wt });
  const p = doc.rows.find((r) => r.kind === "plugin");
  assert.equal(p.id, "sales@synced");
  assert.equal(p.enabled, false);
  assert.equal(p.from, "global");
  assert.deepEqual(p.skills, ["sales:account-context"]);
  assert.equal(p.mcpServers, 2);
  const s = doc.rows.find((r) => r.id === "sales:account-context");
  assert.equal(s.switchable, false);
  assert.equal(s.plugin, "sales@synced");
  assert.equal(p.listingChars, s.listingChars);
  assert.ok(s.listingChars > 0 && s.bodyChars > 0);
  assert.equal(doc.totals.pluginChars, 0, "the plugin is off, so its skills are not in what every turn carries");
});

test("totals follow the effective state: off is nothing, name-only its name line, a plugin on counts its skills", async () => {
  resetPluginListCache();
  const before = (await buildInventory({ worktree: wt })).doc;
  const proj = before.rows.find((r) => r.id === "proj");
  assert.equal(proj.effective, "name-only");
  const mine = before.rows.find((r) => r.id === "mine"), docx = before.rows.find((r) => r.id === "anthropic-skills:docx");
  assert.equal(before.totals.skillChars, mine.listingChars + docx.listingChars + "proj".length + 2);
  writeFileSync(join(cfg, "settings.json"), JSON.stringify({ skillOverrides: { mine: "off", proj: "name-only" } }));
  resetPluginListCache();
  const after = (await buildInventory({ worktree: wt })).doc;
  const s = after.rows.find((r) => r.id === "sales:account-context");
  assert.equal(after.rows.find((r) => r.kind === "plugin").enabled, true);
  assert.equal(after.totals.pluginChars, s.listingChars);
  assert.equal(after.totals.skillChars, mine.listingChars + docx.listingChars + "proj".length + 2, "mine is on again in the repo file");
  writeFileSync(join(cfg, "settings.json"), JSON.stringify({ skillOverrides: { mine: "off", proj: "name-only" }, enabledPlugins: { "sales@synced": false } }));
});

test("the plugin list is dropped after a write, so inherit shows the default at once", async () => {
  const { applySkillWrite } = await import("../dist/skills/skillwrite.js");
  writeFileSync(stub, `#!/bin/sh\necho '${JSON.stringify([{ id: "sales@synced", scope: "synced", enabled: false, installPath: plug }])}'\n`);
  resetPluginListCache();
  const first = (await buildInventory({ worktree: wt })).doc;
  assert.equal(first.rows.find((r) => r.kind === "plugin").enabled, false);
  writeFileSync(join(cfg, "settings.json"), JSON.stringify({ enabledPlugins: { "sales@synced": false } }));
  const gdoc = (await buildInventory()).doc;
  const rev = gdoc.layers.find((l) => l.level === "global").rev;
  // Flip the CLI's own default, then inherit: without a cache drop the card would still read off.
  writeFileSync(stub, `#!/bin/sh\necho '${JSON.stringify([{ id: "sales@synced", scope: "synced", enabled: true, installPath: plug }])}'\n`);
  const r = applySkillWrite({ level: "global", revs: { global: rev }, changes: [{ kind: "plugin", id: "sales@synced", to: "inherit" }], allowed: ["global"], doc: gdoc });
  assert.equal(r.ok, true);
  const p = (await buildInventory()).doc.rows.find((x) => x.kind === "plugin");
  assert.equal(p.enabled, true);
  assert.equal(p.from, "default");
});

test("weightOf: listing line, body, cap", () => {
  const t = "---\nname: x\ndescription: abcdefghij\n---\nbody\n";
  assert.equal(weightOf("x", t).listingChars, 1 + 10 + 4);
  const c = weightOf("x", t, 4);
  assert.equal(c.capped, true);
  assert.equal(c.listingChars, 1 + 4 + 4);
  // No description: the CLI lists the first body line (verified headless 2026-11-12, 2.1.322), `#` marks dropped.
  assert.equal(weightOf("x", "no frontmatter").listingChars, 1 + 14 + 4);
  assert.equal(weightOf("x", "---\nname: x\n---\n\n# Head\nmore\n").listingChars, 1 + 4 + 4);
  assert.equal(weightOf("x", "---\nname: x\n---\n").listingChars, 3, "nothing to list but the name");
});

test("weightOf: the CLI's own 1536 cap applies unset, and when_to_use is part of the entry", () => {
  const long = "---\nname: x\ndescription: " + "a".repeat(3000) + "\n---\nbody\n";
  const w = weightOf("x", long);
  assert.equal(w.capped, true);
  assert.equal(w.listingChars, 1 + 1536 + 4);
  assert.equal(weightOf("x", long, 4000).capped, false);
  const both = "---\nname: x\ndescription: abc\nwhen_to_use: defgh\n---\nb\n";
  assert.equal(weightOf("x", both).listingChars, 1 + (3 + 3 + 5) + 4);
});

test("a failing plugin list falls back to disk and says so", async () => {
  writeFileSync(stub, "#!/bin/sh\nexit 1\n");
  resetPluginListCache();
  const { doc } = await buildInventory();
  assert.match(doc.hostNote, /plugin list could not be run/);
  assert.ok(doc.rows.find((r) => r.id === "sales@synced"), "synced dir scan finds it");
});

test("repoReferences: word boundaries, own file excluded, names only", () => {
  const r = repoReferences(wt, ["mine", "proj", "mine-x"], { proj: join(wt, ".claude", "skills", "proj", "SKILL.md") });
  assert.deepEqual(r, { mine: ["CLAUDE.md"] });
});

test("author lock, plugin dir ids and the bare synced key follow the CLI", async () => {
  skill(join(cfg, "skills", "deploy"), "deploy", "Ship it");
  writeFileSync(join(cfg, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Ship it\ndisable-model-invocation: true\n---\nbody\n");
  skill(join(plug, "skills", "forecast"), "Sales Forecast", "Numbers");
  skill(join(plug, "skills", "odd dir"), "sales:odd", "Odd");
  skill(join(plug, "skills", "setup"), "setup", "x".repeat(400));
  writeFileSync(join(plug, "skills", "setup", "SKILL.md"), `---\nname: setup\ndescription: ${"x".repeat(400)}\ndisable-model-invocation: true\n---\nbody\n`);
  writeFileSync(join(cfg, "settings.json"), JSON.stringify({ skillOverrides: { deploy: "off", docx: "off" } }));
  writeFileSync(stub, `#!/bin/sh\necho '${JSON.stringify([{ id: "sales@synced", scope: "synced", enabled: true, installPath: plug }])}'\n`);
  resetPluginListCache();
  const { doc } = await buildInventory();
  const d = doc.rows.find((r) => r.id === "deploy");
  assert.equal(d.effective, "off", "any off beats disable-model-invocation in the CLI");
  assert.equal(d.from, "global");
  assert.equal(d.lockedBy, undefined);
  assert.equal(d.locked, undefined, "so the row stays switchable and the key can be removed");
  assert.deepEqual(d.set, { global: "off" });
  skill(join(cfg, "skills", "plain"), "plain", "P");
  writeFileSync(join(cfg, "skills", "plain", "SKILL.md"), "---\nname: plain\ndescription: P\ndisable-model-invocation: true\n---\nbody\n");
  resetPluginListCache();
  const lockedRow = (await buildInventory()).doc.rows.find((r) => r.id === "plain");
  assert.equal(lockedRow.effective, "user-invocable-only");
  assert.equal(lockedRow.lockedBy, "author");
  const mine = doc.rows.find((r) => r.id === "mine"), docx = doc.rows.find((r) => r.id === "anthropic-skills:docx");
  assert.equal(doc.totals.skillChars, mine.listingChars + 0 + 0 + 0, "locked deploy, off docx (bare key), off mine carry nothing");
  assert.equal(docx.effective, "off");
  assert.equal(docx.from, "global");
  assert.deepEqual(docx.set, { global: "off" });
  const p = doc.rows.find((r) => r.kind === "plugin");
  assert.ok(p.skills.includes("sales:forecast"), "dir name, not the frontmatter name");
  assert.ok(p.skills.includes("sales:odd-dir"), "odd characters become a dash");
  assert.ok(!p.skills.some((id) => id.includes("Sales Forecast") || id === "sales:sales:odd"));
  const listed = doc.rows.filter((r) => r.kind === "skill" && r.plugin === p.id && r.lockedBy !== "author").reduce((n, r) => n + r.listingChars, 0);
  assert.equal(p.listingChars, listed, "an author-locked plugin skill is not in the plugin's weight");
  assert.equal(p.listingChars, doc.totals.pluginChars, "so the plugin's figure and the total agree");
});

test("a bare synced key is ignored when a personal or project skill holds the bare name", async () => {
  skill(join(cfg, "skills", "synced", "acct", "pdf"), "pdf", "Pdfs");
  skill(join(cfg, "skills", "synced", "acct", "proj"), "proj", "Synced proj");
  writeFileSync(join(cfg, "settings.json"), JSON.stringify({ skillOverrides: { pdf: "off", proj: "off" } }));
  resetPluginListCache();
  const { doc } = await buildInventory({ worktree: wt, repoId: "r1" });
  assert.equal(doc.rows.find((r) => r.id === "anthropic-skills:pdf").effective, "off", "bare name free: it switches the synced skill");
  const sp = doc.rows.find((r) => r.id === "anthropic-skills:proj");
  assert.equal(sp.effective, "on", "bare name reserved by the project skill");
  assert.deepEqual(sp.set, {});
});

test("skillListingMaxDescChars: the highest-precedence source wins, not the smallest", async () => {
  const { readSkillLayers } = await import("../dist/skills/skilllayers.js");
  writeFileSync(join(cfg, "settings.json"), JSON.stringify({ skillListingMaxDescChars: 200 }));
  writeFileSync(join(wt, ".claude", "settings.json"), JSON.stringify({ skillListingMaxDescChars: 900 }));
  writeFileSync(join(wt, ".claude", "settings.local.json"), "{}");
  assert.equal(readSkillLayers(wt).maxDesc, 900, "repo file beats global even though it is larger");
  writeFileSync(join(wt, ".claude", "settings.local.json"), JSON.stringify({ skillListingMaxDescChars: 300 }));
  assert.equal(readSkillLayers(wt).maxDesc, 300);
});
